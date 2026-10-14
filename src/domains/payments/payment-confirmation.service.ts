import { OrderStatus, PaymentStatus, Prisma, PrismaClient } from "@prisma/client";
import { canTransitionOrder } from "../commerce/order-state-machine";
import { canTransitionPayment } from "./payment-state-machine";

export type ConfirmPaymentInput = {
  tenantId: string;
  paymentId: string;
  providerReference: string;
  correlationId: string;
};

export class PaymentConfirmationService {
  constructor(private readonly db: PrismaClient) {}

  async confirm(input: ConfirmPaymentInput) {
    if (!input.tenantId.trim() || !input.paymentId.trim() || !input.providerReference.trim()) {
      throw new Error("Tenant, payment, and provider reference are required.");
    }

    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, tenantId: input.tenantId }
      });
      if (!payment) throw new Error("Payment not found.");

      if (payment.status === PaymentStatus.CONFIRMED) {
        return { payment, duplicate: true };
      }

      if (!canTransitionPayment(payment.status, PaymentStatus.CONFIRMED)) {
        throw new Error(`Payment cannot be confirmed from status ${payment.status}.`);
      }

      const order = await tx.order.findFirst({
        where: { id: payment.orderId, tenantId: input.tenantId }
      });
      if (!order) throw new Error("Payment order not found.");

      if (order.totalMinor !== payment.amountMinor || order.currency !== payment.currency) {
        throw new Error("Payment amount or currency does not match the order.");
      }

      if (order.status !== OrderStatus.PAID && !canTransitionOrder(order.status, OrderStatus.PAID)) {
        throw new Error(`Order cannot be marked paid from status ${order.status}.`);
      }

      const updatedPayment = await tx.payment.updateMany({
        where: { id: payment.id, tenantId: input.tenantId, status: payment.status },
        data: {
          status: PaymentStatus.CONFIRMED,
          providerRef: input.providerReference,
          confirmedAt: new Date()
        }
      });
      if (updatedPayment.count !== 1) throw new Error("Payment changed concurrently; retry the confirmation.");

      const updatedOrder = await tx.order.updateMany({
        where: { id: order.id, tenantId: input.tenantId, status: order.status },
        data: { status: OrderStatus.PAID }
      });
      if (updatedOrder.count !== 1) throw new Error("Order changed concurrently; retry the confirmation.");

      await tx.event.create({
        data: {
          tenantId: input.tenantId,
          type: "payment.confirmed",
          aggregateType: "Payment",
          aggregateId: payment.id,
          correlationId: input.correlationId,
          payload: {
            paymentId: payment.id,
            orderId: order.id,
            amountMinor: payment.amountMinor.toString(),
            currency: payment.currency,
            providerReference: input.providerReference
          } as Prisma.InputJsonValue
        }
      });

      const confirmed = await tx.payment.findFirst({
        where: { id: payment.id, tenantId: input.tenantId }
      });
      return { payment: confirmed, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
