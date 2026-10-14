import { OrderStatus, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentConfirmationService } from "./payment-confirmation.service";

const mocks = vi.hoisted(() => ({
  paymentFindFirst: vi.fn(),
  paymentUpdateMany: vi.fn(),
  orderFindFirst: vi.fn(),
  orderUpdateMany: vi.fn(),
  eventCreate: vi.fn()
}));

function makeService() {
  const tx = {
    payment: { findFirst: mocks.paymentFindFirst, updateMany: mocks.paymentUpdateMany },
    order: { findFirst: mocks.orderFindFirst, updateMany: mocks.orderUpdateMany },
    event: { create: mocks.eventCreate }
  };
  const db = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
  };
  return new PaymentConfirmationService(db as never);
}

const input = {
  tenantId: "tenant-a",
  paymentId: "payment-a",
  providerReference: "provider-ref-a",
  correlationId: "correlation-a"
};

const payment = {
  id: "payment-a",
  tenantId: "tenant-a",
  orderId: "order-a",
  status: PaymentStatus.VERIFYING,
  amountMinor: 1500n,
  currency: "IRR"
};

const order = {
  id: "order-a",
  tenantId: "tenant-a",
  status: OrderStatus.PENDING_PAYMENT,
  totalMinor: 1500n,
  currency: "IRR"
};

describe("payment confirmation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not find or confirm a payment outside the requested tenant", async () => {
    mocks.paymentFindFirst.mockResolvedValue(null);
    const service = makeService();

    await expect(service.confirm(input)).rejects.toThrow("Payment not found.");
    expect(mocks.paymentFindFirst).toHaveBeenCalledWith({
      where: { id: "payment-a", tenantId: "tenant-a" }
    });
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("rejects amount or currency mismatches before mutating payment or order", async () => {
    mocks.paymentFindFirst.mockResolvedValue({ ...payment, amountMinor: 1501n });
    mocks.orderFindFirst.mockResolvedValue(order);
    const service = makeService();

    await expect(service.confirm(input)).rejects.toThrow("Payment amount or currency does not match the order.");
    expect(mocks.orderFindFirst).toHaveBeenCalledWith({
      where: { id: "order-a", tenantId: "tenant-a" }
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.orderUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("confirms payment and marks the tenant-scoped order paid atomically", async () => {
    const confirmedPayment = { ...payment, status: PaymentStatus.CONFIRMED };
    mocks.paymentFindFirst
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce(confirmedPayment);
    mocks.orderFindFirst.mockResolvedValue(order);
    mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.eventCreate.mockResolvedValue({ id: "event-a" });
    const service = makeService();

    await expect(service.confirm(input)).resolves.toEqual({
      payment: confirmedPayment,
      duplicate: false
    });
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "payment-a", tenantId: "tenant-a", status: PaymentStatus.VERIFYING },
      data: {
        status: PaymentStatus.CONFIRMED,
        providerRef: "provider-ref-a",
        confirmedAt: expect.any(Date)
      }
    });
    expect(mocks.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-a", tenantId: "tenant-a", status: OrderStatus.PENDING_PAYMENT },
      data: { status: OrderStatus.PAID }
    });
    expect(mocks.eventCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-a",
        type: "payment.confirmed",
        aggregateType: "Payment",
        aggregateId: "payment-a",
        correlationId: "correlation-a",
        payload: {
          paymentId: "payment-a",
          orderId: "order-a",
          amountMinor: "1500",
          currency: "IRR",
          providerReference: "provider-ref-a"
        }
      }
    });
  });

  it("treats an already confirmed payment as an idempotent duplicate", async () => {
    const confirmedPayment = { ...payment, status: PaymentStatus.CONFIRMED };
    mocks.paymentFindFirst.mockResolvedValue(confirmedPayment);
    const service = makeService();

    await expect(service.confirm(input)).resolves.toEqual({
      payment: confirmedPayment,
      duplicate: true
    });
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.orderUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });

  it("rejects concurrent payment changes instead of marking the order paid", async () => {
    mocks.paymentFindFirst.mockResolvedValue(payment);
    mocks.orderFindFirst.mockResolvedValue(order);
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });
    const service = makeService();

    await expect(service.confirm(input)).rejects.toThrow("Payment changed concurrently; retry the confirmation.");
    expect(mocks.orderUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});
