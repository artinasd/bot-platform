export type PriceLine = {
  unitPriceMinor: bigint;
  quantity: number;
};

export type PriceSummary = {
  subtotalMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
};

export function calculateOrderPrice(lines: PriceLine[], discountMinor = 0n): PriceSummary {
  if (lines.length === 0) throw new Error("An order must contain at least one line item.");
  if (discountMinor < 0n) throw new Error("Discount cannot be negative.");

  const subtotalMinor = lines.reduce((sum, line) => {
    if (line.unitPriceMinor < 0n) throw new Error("Unit price cannot be negative.");
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000) {
      throw new Error("Quantity must be a safe integer between 1 and 10000.");
    }
    return sum + line.unitPriceMinor * BigInt(line.quantity);
  }, 0n);

  if (discountMinor > subtotalMinor) throw new Error("Discount cannot exceed the subtotal.");

  return {
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor
  };
}
