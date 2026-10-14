import { describe, expect, it } from "vitest";
import { hashSessionToken } from "./session.service";

describe("session token hashing", () => {
  it("stores a fixed-length digest instead of the raw session token", () => {
    const token = "random-opaque-session-token";
    const digest = hashSessionToken(token);
    expect(digest).not.toBe(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces stable hashes for token lookup", () => {
    expect(hashSessionToken("same-token")).toBe(hashSessionToken("same-token"));
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
  });
});
