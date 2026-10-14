import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PARAMETERS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Password must be between 12 and 1024 characters.");
  }

  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: PARAMETERS.N,
    r: PARAMETERS.r,
    p: PARAMETERS.p,
    maxmem: 64 * 1024 * 1024
  }) as Buffer;

  return ["scrypt", PARAMETERS.N, PARAMETERS.r, PARAMETERS.p, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== PARAMETERS.N || r !== PARAMETERS.r || p !== PARAMETERS.p) return false;

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;

  try {
    const actual = await scrypt(password, salt, KEY_LENGTH, {
      N: n,
      r,
      p,
      maxmem: 64 * 1024 * 1024
    }) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
