import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret } from "./secrets";

describe("API key security", () => {
  const key = "01234567890123456789012345678901";

  it("encrypts with a random IV and decrypts the original value", () => {
    const first = encryptSecret("sk-secret-value", key);
    const second = encryptSecret("sk-secret-value", key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe("sk-secret-value");
  });

  it("masks the API key for browser responses", () => {
    expect(maskSecret("sk-1234567890abcdef")).toBe("sk-1****cdef");
  });
});
