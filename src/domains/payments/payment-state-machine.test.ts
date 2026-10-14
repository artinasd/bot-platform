import { PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { canTransitionPayment, transitionPayment, InvalidPaymentTransitionError } from "./payment-state-machine";

describe("payment state machine", () => {
  it("allows a verified payment to be confirmed", () => {
    expect(transitionPayment(PaymentStatus.VERIFYING, PaymentStatus.CONFIRMED)).toBe(PaymentStatus.CONFIRMED);
  });

  it("does not allow a rejected payment to be confirmed directly", () => {
    expect(canTransitionPayment(PaymentStatus.REJECTED, PaymentStatus.CONFIRMED)).toBe(false);
    expect(() => transitionPayment(PaymentStatus.REJECTED, PaymentStatus.CONFIRMED)).toThrow(InvalidPaymentTransitionError);
  });

  it("requires explicit state changes after refund", () => {
    expect(() => transitionPayment(PaymentStatus.REFUNDED, PaymentStatus.CONFIRMED)).toThrow(InvalidPaymentTransitionError);
  });
});
