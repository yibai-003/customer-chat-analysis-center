function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface TransportOptions { signal?: AbortSignal; timeoutMs?: number; attempts?: number; consumeRequest?: () => void }
function transient(error: unknown): boolean {
  const e = error as { name?: string; message?: string; code?: string; cause?: unknown };
  if (/CERT|TLS|SSL/i.test(e?.code ?? "")) return false;
  if (e?.cause) return transient(e.cause);
  return /AbortError|TimeoutError/.test(e?.name ?? "") || /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|UND_ERR/i.test(`${e?.message} ${e?.code}`);
}

/** Timeout includes body consumption; bounded retries never outlive caller cancellation. */
export async function requestModel(url: string, init: RequestInit, options: TransportOptions = {}) {
  const attempts = Math.min(3, Math.max(1, options.attempts ?? 3));
  for (let attempt = 0; attempt < attempts; attempt++) {
    options.signal?.throwIfAborted();
    options.consumeRequest?.();
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new DOMException("Model request timed out", "TimeoutError")), options.timeoutMs ?? 90_000);
    let wait = [5000, 15000][attempt] ?? 15000;
    try {
      const response = await fetch(url, { ...init, signal });
      const rawText = await response.text();
      signal.throwIfAborted();
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) return { response, rawText, attemptsUsed: attempt + 1 };
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(ms)) wait = Math.max(wait, Math.min(30_000, Math.max(0, ms)));
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt === attempts - 1 || !transient(error)) throw error;
    } finally { clearTimeout(timer); }
    await delay(wait, options.signal);
  }
  throw new Error("Model request exhausted");
}
