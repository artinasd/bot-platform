import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./credential-encryption";

const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
});

describe("credential encryption", () => {
  it("round-trips a secret with a valid key", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const ciphertext = encryptCredential("provider-token-secret");

    expect(ciphertext).not.toContain("provider-token-secret");
    expect(decryptCredential(ciphertext)).toBe("provider-token-secret");
  });

  it("rejects malformed encryption keys", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "not-a-key";
    expect(() => encryptCredential("secret")).toThrow(/32-byte key/);
  });

  it("rejects tampered ciphertext", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const ciphertext = encryptCredential("secret");
    const parts = ciphertext.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");

    expect(() => decryptCredential(parts.join("."))).toThrow();
  });
});
