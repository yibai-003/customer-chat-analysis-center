import { describe, expect, it } from "vitest";
import { startServer } from "./startup";

interface FakeServer {
  requestTimeout: number;
  headersTimeout: number;
  timeout: number;
}

function createHarness() {
  const events: string[] = [];
  const server: FakeServer = {
    requestTimeout: 0,
    headersTimeout: 0,
    timeout: 1,
  };
  let listeningCallback: (() => void) | undefined;

  const result = startServer({
    port: 4321,
    createApplication: () => ({
      listen: (port, host, callback) => {
        expect(host).toBe("127.0.0.1");
        events.push(`listen:${port}`);
        listeningCallback = callback;
        return server;
      },
    }),
    recoverStaleJobRuns: () => {
      events.push("recover-runs");
    },
    recoverImportJobs: () => {
      events.push("recover-imports");
    },
    log: (message) => {
      events.push(`log:${message}`);
    },
  });

  return {
    events,
    server,
    result,
    signalListening: () => listeningCallback?.(),
  };
}

describe("server startup", () => {
  it("does not touch recovery state before the port is listening", () => {
    const harness = createHarness();

    expect(harness.events).toEqual(["listen:4321"]);
    expect(harness.result).toBe(harness.server);
  });

  it("runs recovery in order only after listening succeeds", () => {
    const harness = createHarness();

    harness.signalListening();

    expect(harness.events).toEqual([
      "listen:4321",
      "recover-runs",
      "recover-imports",
      "log:客服解析中心 running at http://localhost:4321",
    ]);
    expect(harness.server).toMatchObject({
      requestTimeout: 2 * 60 * 60 * 1000,
      headersTimeout: 2 * 60 * 60 * 1000 + 60_000,
      timeout: 0,
    });
  });
});
