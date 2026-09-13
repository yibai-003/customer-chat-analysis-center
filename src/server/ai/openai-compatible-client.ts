import { requestModel, type TransportOptions } from "./model-transport";
import { currentModelBudget, withModelBudget } from "./model-budget";
export interface DecryptedModelConfig {
  baseUrl: string; apiKey: string; model: string; temperature: number; maxTokens: number;
}

export function classifyModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return { code: "timeout", message: "模型请求超时，请稍后重试" };
  if (/401|403|api.?key|unauthor/i.test(message)) return { code: "auth", message: "模型鉴权失败，请检查 API Key" };
  if (/429|rate.?limit/i.test(message)) return { code: "rate_limit", message: "模型请求过于频繁，请稍后重试" };
  if (/fetch failed|network|ECONN|ENOTFOUND/i.test(message)) return { code: "network", message: "模型服务连接失败，请检查接口地址" };
  return { code: "model", message };
}

export function extractMessageContent(message: any): string {
  if (typeof message === "string") return message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((item: any) => typeof item === "string" ? item : item?.text ?? item?.value ?? item?.output_text)
      .filter((item: unknown): item is string => typeof item === "string")
      .join("\n");
  }
  if (typeof message?.content?.text === "string") return message.content.text;
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.output_text === "string") return message.output_text;
  if (typeof message?.reasoning_content === "string") return message.reasoning_content;
  return "";
}

export function extractResponseContent(body: any): string {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) {
    return body.map((item) => extractResponseContent(item)).filter(Boolean).join("\n");
  }
  const choice = body?.choices?.[0];
  const choiceContent = extractMessageContent(choice?.message) || extractMessageContent(choice);
  if (choiceContent) return choiceContent;
  if (typeof body?.output_text === "string") return body.output_text;
  if (Array.isArray(body?.output)) {
    return body.output
      .map((item: any) => extractMessageContent(item) || extractMessageContent(item?.content))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseResponseText(rawText: string) {
  try {
    return JSON.parse(rawText);
  } catch {
    const chunks = rawText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => {
        try { return JSON.parse(line); } catch { return line; }
      });
    return chunks.length ? chunks : rawText;
  }
}

export function buildChatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/$/, "");
  if (/\/v\d+(?:\/|$)/i.test(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export async function callVisionModel(config: DecryptedModelConfig, messages: unknown[], options: TransportOptions = {}) {
  return withModelBudget(() => callWithinBudget(config, messages, options), { signal: options.signal });
}

async function callWithinBudget(config: DecryptedModelConfig, messages: unknown[], options: TransportOptions) {
  const budget = currentModelBudget()!;
  budget.check();
  const signal = options.signal ? AbortSignal.any([budget.signal, options.signal]) : budget.signal;
  let attemptsLeft = Math.min(3, Math.max(1, options.attempts ?? 3));
  const jsonMessages = messages.map((message: any) => {
    if (!message || typeof message !== "object") return message;
    if (typeof message.content === "string" && !/\bjson\b/i.test(message.content)) {
      return { ...message, content: `${message.content}\nPlease return valid json only.` };
    }
    return message;
  });
  const request = async (withResponseFormat: boolean) => {
    const result = await requestModel(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: config.temperature, max_tokens: config.maxTokens,
        ...(withResponseFormat ? { response_format: { type: "json_object" } } : {}), messages: jsonMessages }),
    }, { ...options, signal, attempts: attemptsLeft, consumeRequest: budget.consume });
    attemptsLeft -= result.attemptsUsed;
    return result;
  };
  let { response, rawText } = await request(true);
  let body = parseResponseText(rawText);
  if (attemptsLeft > 0 && !response.ok && response.status === 400 && /response.format|response_format|json_object/i.test(body?.error?.message ?? "")) {
    ({ response, rawText } = await request(false));
    body = parseResponseText(rawText);
  }
  if (!response!.ok) {
    if (/^\s*<(?:!doctype|html)\b/i.test(rawText)) {
      throw new Error("模型接口地址返回了网页内容，请将地址配置为 OpenAI 兼容 API 地址（通常以 /v1 结尾）");
    }
    throw new Error(body?.error?.message || `模型服务错误 (${response!.status})`);
  }
  if (/^\s*<(?:!doctype|html)\b/i.test(rawText)) {
    throw new Error("模型接口地址返回了网页内容，请将地址配置为 OpenAI 兼容 API 地址（通常以 /v1 结尾）");
  }
  const choice = body?.choices?.[0];
  const content = extractResponseContent(body);
  if (!content) {
    const shape = [
      `choices=${Array.isArray(body?.choices) ? body.choices.length : 0}`,
      `message=${choice?.message ? Object.keys(choice.message).join(",") || "object" : "none"}`,
      `choice=${choice ? Object.keys(choice).join(",") || "object" : "none"}`,
      `body=${body && typeof body === "object" ? Object.keys(body).join(",") || "object" : typeof body}`,
      rawText ? `raw=${rawText.slice(0, 160).replace(/\s+/g, " ")}` : "",
      body?.choices?.[0]?.finish_reason ? `finish_reason=${body.choices[0].finish_reason}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`模型响应缺少文本内容（${shape}）`);
  }
  return { content, raw: JSON.stringify(body), usage: body.usage ?? {} };
}
