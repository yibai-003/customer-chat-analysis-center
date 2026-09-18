import express from "express";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localAccess } from "./local-access";
import { config } from "../config";
let server: http.Server;
let port: number;
let writes = 0;
const originalHosts = config.allowedHosts;
const originalOrigins = config.allowedOrigins;
beforeAll(async () => {
  const app = express(); app.use(localAccess); app.post("/write", (_req, res) => { writes++; res.json({ ok: true }); }); app.get("/read", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve)); port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  config.allowedHosts = originalHosts;
  config.allowedOrigins = originalOrigins;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
function request(headers: Record<string,string>, method = "POST") {
  return new Promise<number>((resolve,reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: method === "GET" ? "/read" : "/write", method, headers }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  });
}
describe("loopback browser access", () => {
  it("allows same-origin workbench, local CLI and the Vite proxy", async () => {
    expect(await request({})).toBe(200);
    expect(await request({ origin: `http://localhost:${port}` })).toBe(200);
    expect(await request({ origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" })).toBe(200);
  });
  it("rejects rebinding hosts, third-party forms, opaque origins and unapproved local ports before writes", async () => {
    const before = writes;
    const cases: Record<string,string>[] = [{ host: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "null" }, { origin: "http://localhost:9999" }, { "sec-fetch-site": "cross-site" }, { host: "localhost.evil.example" }];
    for (const headers of cases) {
      expect(await request(headers)).toBe(403);
    }
    expect(writes).toBe(before);
    expect(await request({ host: "attacker.example" }, "GET")).toBe(403);
  });
});
describe("configured internal reverse proxy entry", () => {
  it("accepts the configured host only with the configured origin", async () => {
    config.allowedHosts = ["chat.example.lan"];
    config.allowedOrigins = ["https://chat.example.lan"];
    expect(await request({ host: "chat.example.lan", origin: "https://chat.example.lan" })).toBe(200);
    expect(await request({ host: "chat.example.lan", "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await request({ host: "chat.example.lan", origin: "https://attacker.example" })).toBe(403);
    expect(await request({ host: "chat.example.lan", origin: "http://chat.example.lan" })).toBe(403);
    expect(await request({ host: "chat.example.lan", origin: "null" })).toBe(403);
    expect(await request({ host: "chat.example.lan", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await request({ host: "other.example.lan", origin: "https://chat.example.lan" })).toBe(403);
    expect(await request({ host: "chat.example.lan", origin: `http://localhost:${port}` })).toBe(403);
  });
  it("keeps loopback access working while an internal entry is configured", async () => {
    config.allowedHosts = ["chat.example.lan"];
    config.allowedOrigins = ["https://chat.example.lan"];
    expect(await request({})).toBe(200);
    expect(await request({ origin: `http://localhost:${port}` })).toBe(200);
    expect(await request({ origin: "http://127.0.0.1:5173" })).toBe(200);
  });
});
