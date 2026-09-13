import type { RequestHandler } from "express";

function localUrl(value: string) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return;
    return u;
  } catch { return; }
}

/** Browser boundary; does not authenticate native programs running on this machine. */
export const localAccess: RequestHandler = (req, res, next) => {
  const host = req.get("host");
  const local = host && localUrl(`http://${host}`);
  const deny = () => res.status(403).json({ success: false, data: null, error: "仅允许本机工作台访问此接口" });
  if (!local || local.pathname !== "/" || local.search || local.hash) { deny(); return; }
  const origin = req.get("origin");
  if (origin) {
    const source = localUrl(origin);
    const allowedPorts = new Set([local.port || "80", "5173"]);
    if (!source || source.origin !== origin || !allowedPorts.has(source.port || (source.protocol === "https:" ? "443" : "80"))) { deny(); return; }
  } else if (req.get("sec-fetch-site") === "cross-site") { deny(); return; }
  next();
};
