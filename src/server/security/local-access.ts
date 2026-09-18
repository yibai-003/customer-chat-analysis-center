import type { RequestHandler } from "express";
import { config } from "../config";

function webUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return url;
  } catch {
    return;
  }
}

function localUrl(value: string) {
  const url = webUrl(value);
  if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  return url;
}

function pathIsRoot(url: URL) {
  return url.pathname === "/" && !url.search && !url.hash;
}

/** Browser boundary; does not authenticate native programs running on this machine. */
export const localAccess: RequestHandler = (req, res, next) => {
  const host = req.get("host");
  const local = host ? localUrl(`http://${host}`) : undefined;
  const allowed = host && !local
    ? (() => {
      const url = webUrl(`http://${host}`);
      return url && config.allowedHosts.includes(url.hostname) ? url : undefined;
    })()
    : undefined;
  const deny = () => res.status(403).json({ success: false, data: null, error: "仅允许本机工作台或已配置的内部入口访问此接口" });
  if ((!local && !allowed) || (local && !pathIsRoot(local)) || (allowed && !pathIsRoot(allowed))) { deny(); return; }
  const origin = req.get("origin");
  if (origin) {
    const localSource = localUrl(origin);
    if (localSource) {
      if (!local) { deny(); return; }
      const allowedPorts = new Set([local.port || "80", "5173"]);
      if (localSource.origin !== origin || !allowedPorts.has(localSource.port || (localSource.protocol === "https:" ? "443" : "80"))) { deny(); return; }
    } else if (!config.allowedOrigins.includes(origin.replace(/\/+$/, ""))) { deny(); return; }
  } else if (req.get("sec-fetch-site") === "cross-site") { deny(); return; }
  next();
};