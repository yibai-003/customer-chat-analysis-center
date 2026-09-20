import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

describe("GET /api/version", () => {
  it("is available without authentication and exposes only release metadata", async () => {
    const app = createApp({
      runtimeVersionProvider: () => ({
        version: "0.1.0",
        commitSha: "b".repeat(40),
        buildTime: "2026-09-20T08:00:00.000Z",
        image: "customer-chat-analysis-center:0.1.0-bbbbbbbbbbbb",
        assets: { scripts: ["assets/index-a.js"], styles: ["assets/index-b.css"] },
      }),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/version`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.commitSha).toBe("b".repeat(40));
    expect(JSON.stringify(body)).not.toMatch(/database|apiKey|dataDir|password/i);
  });
});
