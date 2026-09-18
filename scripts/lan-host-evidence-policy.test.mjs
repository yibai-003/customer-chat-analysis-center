import { describe, expect, it } from "vitest";
import { validateHostEvidence } from "./lan-host-evidence-policy.mjs";

function completeEvidence() {
  return {
    schemaVersion: 2,
    mode: "host-signoff",
    productionReady: true,
    collectedAt: "2026-09-18T04:00:00.000Z",
    host: { computer: "LAN-HOST" },
    entry: { host: "chat.example.lan", address: "172.16.20.178" },
    container: {
      image: "customer-chat-analysis:2026-09-18",
      imageId: "sha256:" + "a".repeat(64),
      restartPolicy: "unless-stopped",
      mounts: [
        { type: "bind", source: "E:\\CustomerChatAnalysisData\\data", destination: "/app/data", readOnly: false },
        { type: "bind", source: "E:\\CustomerChatAnalysisData\\knowledge", destination: "/app/knowledge", readOnly: false },
      ],
    },
    backup: { verified: true },
    restore: { verified: true },
    persistence: {
      managedKey: true,
      mountsVerified: true,
      restartVerified: true,
    },
    singleInstance: { rejected: true },
  };
}

const context = {
  workstation: "LAN-CLIENT",
  entryHost: "chat.example.lan",
  dnsAddresses: ["172.16.20.178"],
  expectedImage: "customer-chat-analysis:2026-09-18",
  expectedImageId: "sha256:" + "a".repeat(64),
  now: new Date("2026-09-18T05:00:00.000Z"),
};

describe("LAN host evidence policy", () => {
  it("accepts fresh evidence bound to another computer, DNS address, image, and bind mounts", () => {
    expect(validateHostEvidence(completeEvidence(), context)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects stale or same-computer evidence", () => {
    const evidence = completeEvidence();
    evidence.collectedAt = "2026-09-16T04:00:00.000Z";
    expect(validateHostEvidence(evidence, { ...context, workstation: "lan-host" })).toEqual({
      ok: false,
      errors: expect.arrayContaining(["host-evidence-stale", "same-host-and-workstation"]),
    });
  });

  it("rejects mismatched DNS, images, and named or temporary mounts", () => {
    const evidence = completeEvidence();
    evidence.entry.address = "172.16.20.99";
    evidence.container.image = "customer-chat-analysis:preview";
    evidence.container.mounts[0] = {
      type: "volume",
      source: "preview-data",
      destination: "/app/data",
      readOnly: false,
    };
    evidence.container.mounts[1].source = "C:\\Users\\operator\\AppData\\Local\\Temp\\preview";

    expect(validateHostEvidence(evidence, context)).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        "entry-address-not-in-dns",
        "unexpected-image",
        "persistent-mount-must-be-bind:/app/data",
        "temporary-mount:/app/knowledge",
      ]),
    });
  });

  it("rejects a tag that points at an unapproved image digest", () => {
    const evidence = completeEvidence();
    evidence.container.imageId = "sha256:" + "b".repeat(64);
    expect(validateHostEvidence(evidence, context)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["unexpected-image-id"]),
    });
  });
});
