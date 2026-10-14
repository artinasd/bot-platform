import { describe, expect, it } from "vitest";
import { calculateOrderPrice } from "./order-pricing";

describe("calculateOrderPrice", () => {
  it("uses integer minor units without floating point arithmetic", () => {
    expect(calculateOrderPrice([
      { unitPriceMinor: 125n, quantity: 2 },
      { unitPriceMinor: 50n, quantity: 3 }
    ])).toEqual({ subtotalMinor: 400n, discountMinor: 0n, totalMinor: 400n });
  });

  it("applies a bounded discount", () => {
    expect(calculateOrderPrice([{ unitPriceMinor: 1000n, quantity: 1 }], 250n).totalMinor).toBe(750n);
  });

  it("rejects invalid quantity and discounts", () => {
    expect(() => calculateOrderPrice([{ unitPriceMinor: 100n, quantity: 0 }])).toThrow();
    expect(() => calculateOrderPrice([{ unitPriceMinor: 100n, quantity: 1 }], 101n)).toThrow();
  });

  it("requires at least one item", () => {
    expect(() => calculateOrderPrice([])).toThrow();
  });
});
