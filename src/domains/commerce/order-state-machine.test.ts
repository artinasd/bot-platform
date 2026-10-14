import { OrderStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { canTransitionOrder, transitionOrder, InvalidOrderTransitionError } from "./order-state-machine";

describe("order state machine", () => {
  it("allows payment confirmation to proceed to fulfillment", () => {
    expect(transitionOrder(OrderStatus.PAID, OrderStatus.FULFILLMENT_PENDING)).toBe(OrderStatus.FULFILLMENT_PENDING);
  });

  it("rejects fulfillment before payment", () => {
    expect(canTransitionOrder(OrderStatus.PENDING_PAYMENT, OrderStatus.FULFILLED)).toBe(false);
    expect(() => transitionOrder(OrderStatus.PENDING_PAYMENT, OrderStatus.FULFILLED)).toThrow(InvalidOrderTransitionError);
  });

  it("does not allow transitions out of refunded", () => {
    expect(() => transitionOrder(OrderStatus.REFUNDED, OrderStatus.PAID)).toThrow(InvalidOrderTransitionError);
  });
});
