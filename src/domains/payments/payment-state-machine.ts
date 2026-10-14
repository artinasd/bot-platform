import { PaymentStatus } from "@prisma/client";

const allowedTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["AWAITING_ACTION", "SUBMITTED", "VERIFYING", "CONFIRMED", "REJECTED", "EXPIRED", "CANCELLED"],
  AWAITING_ACTION: ["SUBMITTED", "VERIFYING", "CONFIRMED", "REJECTED", "EXPIRED", "CANCELLED"],
  SUBMITTED: ["VERIFYING", "CONFIRMED", "REJECTED", "EXPIRED", "CANCELLED"],
  VERIFYING: ["CONFIRMED", "REJECTED", "EXPIRED", "CANCELLED", "DISPUTED"],
  CONFIRMED: ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  REJECTED: ["PENDING", "CANCELLED"],
  EXPIRED: ["PENDING", "CANCELLED"],
  CANCELLED: [],
  PARTIALLY_REFUNDED: ["REFUNDED", "DISPUTED"],
  REFUNDED: ["DISPUTED"],
  DISPUTED: ["CONFIRMED", "REJECTED", "PARTIALLY_REFUNDED", "REFUNDED"]
};

export class InvalidPaymentTransitionError extends Error {
  constructor(from: PaymentStatus, to: PaymentStatus) {
    super(`Payment transition ${from} -> ${to} is not allowed.`);
    this.name = "InvalidPaymentTransitionError";
  }
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionPayment(from: PaymentStatus, to: PaymentStatus): PaymentStatus {
  if (!canTransitionPayment(from, to)) throw new InvalidPaymentTransitionError(from, to);
  return to;
}

export function getAllowedPaymentTransitions(from: PaymentStatus): readonly PaymentStatus[] {
  return allowedTransitions[from];
}
