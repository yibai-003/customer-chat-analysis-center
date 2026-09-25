import type express from "express";
import { describe, expect, it } from "vitest";
import { createRouteResponders } from "./route-response";

function response() {
  const state: { status: number; body?: unknown } = { status: 200 };
  const result = {
    status(code: number) {
      state.status = code;
      return result;
    },
    json(body: unknown) {
      state.body = body;
      return body;
    },
  };
  return { state, result: result as unknown as express.Response };
}

describe("route response helpers", () => {
  it("wraps successful data in the shared response envelope", () => {
    const { ok } = createRouteResponders();
    const target = response();

    ok(target.result, { id: "record-1" });

    expect(target.state).toEqual({
      status: 200,
      body: { success: true, data: { id: "record-1" }, error: null },
    });
  });

  it("allows route-specific status and message policies without duplicating the envelope", () => {
    const { fail } = createRouteResponders({
      resolveStatus: (error, fallback) => (
        error instanceof Error && error.message === "冲突"
          ? 409
          : fallback
      ),
      resolveMessage: (error) => (
        error instanceof Error ? `业务错误：${error.message}` : "请求失败"
      ),
    });
    const target = response();

    fail(target.result, new Error("冲突"));

    expect(target.state).toEqual({
      status: 409,
      body: { success: false, data: null, error: "业务错误：冲突" },
    });
  });
});
