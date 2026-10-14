import { afterEach, describe, expect, it } from "vitest";
import { isValidInternalJobAuthorization } from "./internal-job-auth";

const previousSecret = process.env.INTERNAL_JOB_SECRET;
const validSecret = "a-valid-test-secret-with-at-least-32-chars";

afterEach(() => {
  if (previousSecret === undefined) delete process.env.INTERNAL_JOB_SECRET;
  else process.env.INTERNAL_JOB_SECRET = previousSecret;
});

describe("internal job authorization", () => {
  it("accepts the exact configured bearer secret", () => {
    expect(isValidInternalJobAuthorization(`Bearer ${validSecret}`, validSecret)).toBe(true);
  });

  it("rejects missing or malformed authorization headers", () => {
    for (const header of [null, undefined, "", "Basic abc", "bearer token", "Bearer ", `Bearer  ${validSecret}`]) {
      expect(isValidInternalJobAuthorization(header, validSecret)).toBe(false);
    }
  });

  it("rejects incorrect secrets regardless of candidate length", () => {
    expect(isValidInternalJobAuthorization("Bearer wrong", validSecret)).toBe(false);
    expect(isValidInternalJobAuthorization(`Bearer ${"x".repeat(300)}`, validSecret)).toBe(false);
  });

  it("fails closed when the configured secret is missing or weak", () => {
    expect(isValidInternalJobAuthorization(`Bearer ${validSecret}`, undefined)).toBe(false);
    expect(isValidInternalJobAuthorization("Bearer short", "short")).toBe(false);
    expect(isValidInternalJobAuthorization(`Bearer ${validSecret}`, ` ${validSecret}`)).toBe(false);
  });

  it("uses INTERNAL_JOB_SECRET when no explicit secret is supplied", () => {
    process.env.INTERNAL_JOB_SECRET = validSecret;
    expect(isValidInternalJobAuthorization(`Bearer ${validSecret}`)).toBe(true);
    expect(isValidInternalJobAuthorization("Bearer wrong")).toBe(false);
  });
});
