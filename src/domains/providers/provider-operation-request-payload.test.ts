import { describe, expect, it } from "vitest";
import { validateProviderOperationRequestPayload } from "./provider-operation-request-payload";

describe("provider operation request payload validator", () => {
  it("returns a detached normalized snapshot of plain JSON data", () => {
    const input = { plan: "basic", options: { seats: 2 }, tags: ["one", "two"] };
    const normalized = validateProviderOperationRequestPayload(input) as Record<string, unknown>;
    input.options.seats = 9;
    expect(normalized).toEqual({ plan: "basic", options: { seats: 2 }, tags: ["one", "two"] });
  });

  it("accepts empty objects and JSON primitives nested inside objects", () => {
    expect(validateProviderOperationRequestPayload({})).toEqual({});
    expect(validateProviderOperationRequestPayload({ enabled: true, count: 0, note: null })).toEqual({
      enabled: true, count: 0, note: null
    });
  });

  it("rejects non-object roots and non-plain nested objects", () => {
    expect(() => validateProviderOperationRequestPayload(null)).toThrow(/plain object/);
    expect(() => validateProviderOperationRequestPayload([])).toThrow(/plain object/);
    expect(() => validateProviderOperationRequestPayload({ createdAt: new Date() })).toThrow(/plain objects/);
  });

  it("rejects undefined, non-finite numbers, functions, and circular references", () => {
    expect(() => validateProviderOperationRequestPayload({ missing: undefined })).toThrow(/non-JSON value/);
    expect(() => validateProviderOperationRequestPayload({ amount: Number.NaN })).toThrow(/invalid number/);
    expect(() => validateProviderOperationRequestPayload({ callback: () => undefined })).toThrow(/non-JSON value/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateProviderOperationRequestPayload(circular)).toThrow(/circular references/);
  });

  it("rejects sparse arrays, extra array properties, and array accessors", () => {
    const sparse = new Array(2);
    expect(() => validateProviderOperationRequestPayload({ values: sparse })).toThrow(/holes or extra properties/);
    const extra = ["safe"] as string[] & { extra?: string };
    extra.extra = "ignored-by-JSON";
    expect(() => validateProviderOperationRequestPayload({ values: extra })).toThrow(/holes or extra properties/);
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "unsafe" });
    accessor.length = 1;
    expect(() => validateProviderOperationRequestPayload({ values: accessor })).toThrow(/data elements/);
  });

  it("enforces string, array, object, nesting, and total-size limits", () => {
    expect(() => validateProviderOperationRequestPayload({ value: "x".repeat(4097) })).toThrow(/oversized string/);
    expect(() => validateProviderOperationRequestPayload({ values: Array(101).fill("x") })).toThrow(/oversized array/);
    expect(() => validateProviderOperationRequestPayload(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field${index}`, true])
    ))).toThrow(/too many object fields/);
    let deeplyNested: unknown = "end";
    for (let index = 0; index < 9; index += 1) deeplyNested = { child: deeplyNested };
    expect(() => validateProviderOperationRequestPayload({ value: deeplyNested })).toThrow(/nesting limit/);
    expect(() => validateProviderOperationRequestPayload({
      value: "x".repeat(4096),
      second: "y".repeat(4096),
      third: "z".repeat(4096),
      fourth: "a".repeat(4096),
      fifth: "b".repeat(4096)
    })).toThrow(/size limit/);
  });

  it("rejects symbol keys and accessor properties", () => {
    const withSymbol = { value: "safe", [Symbol("hidden")]: "hidden" };
    expect(() => validateProviderOperationRequestPayload(withSymbol)).toThrow(/symbol keys/);
    const withGetter = Object.defineProperty({}, "value", { enumerable: true, get: () => "unsafe" });
    expect(() => validateProviderOperationRequestPayload(withGetter)).toThrow(/data fields/);
  });
});
