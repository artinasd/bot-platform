import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies the original password without storing plaintext", async () => {
    const password = "a-long-unique-password-for-tests";
    const encoded = await hashPassword(password);
    expect(encoded).not.toContain(password);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword("incorrect-password", encoded)).toBe(false);
  });

  it("rejects passwords shorter than the minimum", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/12 and 1024/);
  });

  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });
});
