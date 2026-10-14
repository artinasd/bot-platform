import { describe, expect, it } from "vitest";
import { validateProviderOperationResponsePayload } from "./provider-operation-response-payload";

describe("provider operation response payload validator", () => {
  it("returns a normalized snapshot containing only approved fields", () => {
    const input = { providerRef: "provider-ref", status: "active" };
    const normalized = validateProviderOperationResponsePayload(input) as Record<string, string>;
    input.providerRef = "changed-after-validation";
    expect(normalized).toEqual({ providerRef: "provider-ref", status: "active" });
    expect(Object.getPrototypeOf(normalized)).toBeNull();
  });

  it("accepts an empty response for actions with no persisted reference", () => {
    expect(validateProviderOperationResponsePayload({})).toEqual({});
  });

  it("rejects arrays, null, and non-plain objects", () => {
    expect(() => validateProviderOperationResponsePayload(null)).toThrow(/plain object/);
    expect(() => validateProviderOperationResponsePayload([])).toThrow(/plain object/);
    expect(() => validateProviderOperationResponsePayload(new Date())).toThrow(/plain object/);
  });

  it("rejects padded values and control characters", () => {
    expect(() => validateProviderOperationResponsePayload({ providerRef: " ref " })).toThrow(/invalid field value/);
    expect(() => validateProviderOperationResponsePayload({ requestId: "id\nheader" })).toThrow(/invalid field value/);
  });

  it("rejects unsupported fields and values beyond the field limit", () => {
    expect(() => validateProviderOperationResponsePayload({ rawBody: "vendor response" })).toThrow(/unsupported field/);
    expect(() => validateProviderOperationResponsePayload({ providerRef: "x".repeat(257) })).toThrow(/invalid field value/);
  });
});
