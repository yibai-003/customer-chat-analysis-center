// Minimal OpenAI-compatible stub used to rehearse the real-model acceptance flow
// without spending provider tokens. It answers connectivity probes ("OK", JSON,
// red image) and returns a valid object for the refund `reason` analysis field.
// It intentionally never echoes or logs the Authorization header.
import http from "node:http";

const HOST = process.env.STUB_MODEL_HOST ?? "0.0.0.0";
const PORT = Number(process.env.STUB_MODEL_PORT ?? 8788);

function collectText(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    const content = message?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") parts.push(item);
        else if (typeof item?.text === "string") parts.push(item.text);
      }
    }
  }
  return parts.join("\n");
}

function valueForType(type) {
  switch (type) {
    case "number": return 0.5;
    case "boolean": return true;
    case "object": return { 内容: "验收模拟内容" };
    default: return "验收模拟结论";
  }
}

function analysisReply(text) {
  const key = /目标键为\s*"([^"]+)"/.exec(text)?.[1] ?? "结论";
  const type = /该键的值类型必须为\s*(\w+)/.exec(text)?.[1] ?? "string";
  return JSON.stringify({ [key]: valueForType(type), evidence: "验收模拟证据" });
}

function reply(body) {
  const text = collectText(body?.messages);
  const structured = /结构化客服数据解析助手|响应外层必须是 JSON 对象/.test(text);
  if (structured) return analysisReply(text);
  if (/dominant color/i.test(text)) return "red";
  if (body?.response_format?.type === "json_object" && /ok/i.test(text) && /true/i.test(text)) {
    return JSON.stringify({ ok: true });
  }
  return "OK";
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
    const content = reply(body);
    process.stderr.write(`stub-model ${req.method} ${req.url} model=${body?.model ?? "?"} (key omitted)\n`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `stub-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "stub",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`stub model listening on http://${HOST}:${PORT}/v1\n`);
});
