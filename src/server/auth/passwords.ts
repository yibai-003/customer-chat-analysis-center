import crypto from "node:crypto";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * Deliberately slow, salted scrypt password hash: `scrypt$N$r$p$salt$hash`.
 * A random salt is generated per hash, so identical passwords never collide.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isInteger) || n < 1024 || r < 1 || p < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
  const actual = scrypt(password, salt, n, r, p);
  return crypto.timingSafeEqual(actual, expected);
}

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * p * 2,
  });
}