import crypto from "node:crypto";

function keyBytes(key: string | Buffer) {
  const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return buffer.length === 32 ? buffer : crypto.createHash("sha256").update(buffer).digest();
}

export function encryptSecret(value: string, key: string | Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(ciphertext: string, key: string | Buffer) {
  const [ivText, tagText, valueText] = ciphertext.split(".");
  if (!ivText || !tagText || !valueText) throw new Error("Invalid encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(valueText, "base64url")), decipher.final()]).toString("utf8");
}

export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
