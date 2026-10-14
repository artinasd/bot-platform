import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createStrictProviderRequestPayloadValidator } from "./provider-operation-request-schema";

describe("strict provider request schema", () => {
  const validate = createStrictProviderRequestPayloadValidator({
    plan: z.string().min(1).max(80).refine((value) => value.trim().length > 0),
    seats: z.number().int().min(1).max(100)
  });

  it("accepts a valid action payload", () => {
    expect(() => validate({ plan: "starter", seats: 3 })).not.toThrow();
  });

  it.each([
    null,
    [],
    "starter",
    { plan: "", seats: 1 },
    { plan: "   ", seats: 1 },
    { plan: "starter", seats: 0 },
    { plan: "starter", seats: 1.5 },
    { plan: "starter", seats: 1, admin: true },
    { plan: "starter", seats: "1" }
  ])("rejects invalid or unexpected action payload fields", (payload) => {
    expect(() => validate(payload)).toThrow("Provider request payload does not match the action schema.");
  });
});
