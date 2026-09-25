import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { initDb } from "../db/client";
import { createJob } from "../db/repositories";

describe("platform administration", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;

  beforeAll(async () => {
    initDb();
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const { loginAdmin } = await import("../auth/test-admin");
    cookie = await loginAdmin(baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("creates, renames before use, disables, and restores a platform", async () => {
    const code = `HTTP_${Date.now()}`;
    const createdResponse = await fetch(`${baseUrl}/api/admin/platforms`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "平台管理测试", code }),
    });
    const createdBody = await createdResponse.json();
    expect(createdResponse.status).toBe(200);
    const platform = createdBody.data;

    const renamedResponse = await fetch(`${baseUrl}/api/admin/platforms/${platform.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "平台管理测试改名", code: `${code}_V2` }),
    });
    expect(renamedResponse.status).toBe(200);

    expect((await fetch(`${baseUrl}/api/admin/platforms/${platform.id}/disable`, { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/admin/platforms/${platform.id}/restore`, { method: "POST", headers: { cookie } })).status).toBe(200);
  });

  it("locks platform codes after use and allows only one historical backfill", async () => {
    const code = `BACKFILL_${Date.now()}`;
    const createdResponse = await fetch(`${baseUrl}/api/admin/platforms`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "回填平台", code }),
    });
    const platform = (await createdResponse.json()).data;
    const job = createJob("historical.xlsx", "historical.xlsx");

    const backfill = await fetch(`${baseUrl}/api/admin/jobs/${job.id}/platform-backfill`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ platformId: platform.id, reason: "历史导入缺少平台列" }),
    });
    expect(backfill.status).toBe(200);

    const repeated = await fetch(`${baseUrl}/api/admin/jobs/${job.id}/platform-backfill`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ platformId: platform.id, reason: "重复回填" }),
    });
    expect(repeated.status).toBe(400);

    const renamed = await fetch(`${baseUrl}/api/admin/platforms/${platform.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ code: `${code}_EDITED` }),
    });
    expect(renamed.status).toBe(400);
    expect((await renamed.json()).error).toContain("代码不可修改");
  });
});
