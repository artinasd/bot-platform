import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./credential-encryption";

const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

afterEach(() => {
  if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
});

function setRandomKey() {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
}

describe("credential encryption", () => {
  it("round-trips a secret with a valid key", () => {
    setRandomKey();
    const ciphertext = encryptCredential("provider-token-secret");

    expect(ciphertext).not.toContain("provider-token-secret");
    expect(decryptCredential(ciphertext)).toBe("provider-token-secret");
  });

  it("rejects missing and malformed encryption keys", () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredential("secret")).toThrow(/not configured/);
    expect(() => decryptCredential("v1.a.b.c")).toThrow(/not configured/);

    process.env.CREDENTIAL_ENCRYPTION_KEY = "not-a-key";
    expect(() => encryptCredential("secret")).toThrow(/32-byte key/);
  });

  it("rejects empty plaintext", () => {
    setRandomKey();
    expect(() => encryptCredential("")).toThrow(/non-empty string/);
  });

  it("rejects malformed or unsupported ciphertext envelopes", () => {
    setRandomKey();

    for (const envelope of [
      "",
      "v2.a.b.c",
      "v1.a.b.c",
      "v1.a.b.c.extra",
      "v1...."
    ]) {
      expect(() => decryptCredential(envelope)).toThrow();
    }
  });

  it("rejects tampered ciphertext", () => {
    setRandomKey();
    const ciphertext = encryptCredential("secret");
    const parts = ciphertext.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");

    expect(() => decryptCredential(parts.join("."))).toThrow();
  });

  it("rejects ciphertext encrypted under a different key", () => {
    setRandomKey();
    const ciphertext = encryptCredential("provider-token-secret");
    setRandomKey();

    expect(() => decryptCredential(ciphertext)).toThrow();
  });
});
