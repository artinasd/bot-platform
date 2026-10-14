import { OrderStatus } from "@prisma/client";

const allowedTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["PENDING_PAYMENT", "CANCELLED"],
  PENDING_PAYMENT: ["PAYMENT_PROCESSING", "PAID", "CANCELLED", "FAILED_RETRYABLE", "FAILED_PERMANENT"],
  PAYMENT_PROCESSING: ["PENDING_PAYMENT", "PAID", "CANCELLED", "FAILED_RETRYABLE", "FAILED_PERMANENT"],
  PAID: ["FULFILLMENT_PENDING", "PARTIALLY_REFUNDED", "REFUNDED"],
  FULFILLMENT_PENDING: ["PROVISIONING", "FULFILLED", "DELIVERY_PENDING", "FAILED_RETRYABLE", "FAILED_PERMANENT", "CANCELLED"],
  PROVISIONING: ["FULFILLED", "DELIVERY_PENDING", "FAILED_RETRYABLE", "FAILED_PERMANENT"],
  FULFILLED: ["DELIVERY_PENDING", "DELIVERED", "PARTIALLY_REFUNDED", "REFUNDED"],
  DELIVERY_PENDING: ["DELIVERED", "FAILED_RETRYABLE", "FAILED_PERMANENT"],
  DELIVERED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  FAILED_RETRYABLE: ["PENDING_PAYMENT", "PAYMENT_PROCESSING", "FULFILLMENT_PENDING", "PROVISIONING", "DELIVERY_PENDING", "CANCELLED", "FAILED_PERMANENT"],
  FAILED_PERMANENT: ["CANCELLED", "PARTIALLY_REFUNDED", "REFUNDED"],
  CANCELLED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED: []
};

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Order transition ${from} -> ${to} is not allowed.`);
    this.name = "InvalidOrderTransitionError";
  }
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionOrder(from: OrderStatus, to: OrderStatus): OrderStatus {
  if (!canTransitionOrder(from, to)) throw new InvalidOrderTransitionError(from, to);
  return to;
}

export function getAllowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return allowedTransitions[from];
}
