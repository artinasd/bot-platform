import { randomBytes } from "node:crypto";
import { OrderStatus, Prisma, PrismaClient, RecordStatus, TenantStatus } from "@prisma/client";
import { calculateOrderPrice } from "./order-pricing";

export type CreateOrderItemInput = {
  productId: string;
  planId?: string;
  quantity: number;
  configuration?: Prisma.InputJsonValue;
};

export type CreateOrderInput = {
  tenantId: string;
  customerId: string;
  idempotencyKey: string;
  items: CreateOrderItemInput[];
};

export class OrderService {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateOrderInput) {
    if (!input.tenantId.trim() || !input.customerId.trim() || !input.idempotencyKey.trim()) {
      throw new Error("Tenant, customer, and idempotency key are required.");
    }
    if (input.idempotencyKey.length > 200) throw new Error("Idempotency key is too long.");
    if (input.items.length < 1 || input.items.length > 100) throw new Error("An order must contain between 1 and 100 line items.");

    const existing = await this.db.order.findFirst({
      where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
    });
    if (existing) {
      const items = await this.db.orderItem.findMany({
        where: { tenantId: input.tenantId, orderId: existing.id },
        orderBy: { createdAt: "asc" }
      });
      return { order: { ...existing, items }, duplicate: true };
    }

    try {
      return await this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: input.tenantId, status: TenantStatus.ACTIVE },
        select: { id: true }
      });
      if (!tenant) throw new Error("Active tenant not found.");

      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId: input.tenantId, status: RecordStatus.ACTIVE },
        select: { id: true }
      });
      if (!customer) throw new Error("Active customer not found in this tenant.");

      const lines: Array<{ productId: string; planId: string | null; quantity: number; unitPriceMinor: bigint; currency: string; configuration: Prisma.InputJsonValue }> = [];
      for (const item of input.items) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) {
          throw new Error("Item quantity must be between 1 and 10000.");
        }

        const product = await tx.product.findFirst({
          where: { id: item.productId, tenantId: input.tenantId, status: RecordStatus.ACTIVE },
          select: { id: true, priceMinor: true, currency: true }
        });
        if (!product) throw new Error("An order product is unavailable in this tenant.");

        let unitPriceMinor = product.priceMinor;
        if (item.planId) {
          const plan = await tx.plan.findFirst({
            where: {
              id: item.planId,
              productId: product.id,
              tenantId: input.tenantId,
              status: RecordStatus.ACTIVE
            },
            select: { priceMinor: true, currency: true }
          });
          if (!plan) throw new Error("An order plan is unavailable for this product.");
          if (plan.currency !== product.currency) throw new Error("Plan currency does not match product currency.");
          unitPriceMinor = plan.priceMinor;
        }

        lines.push({
          productId: product.id,
          planId: item.planId ?? null,
          quantity: item.quantity,
          unitPriceMinor,
          currency: product.currency,
          configuration: item.configuration ?? {}
        });
      }

      const currencies = new Set(lines.map((line) => line.currency));
      if (currencies.size !== 1) throw new Error("All items in an order must use the same currency.");

      const price = calculateOrderPrice(lines.map((line) => ({
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity
      })));
      const currency = lines[0].currency;
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;

      const order = await tx.order.create({
        data: {
          tenantId: input.tenantId,
          customerId: input.customerId,
          orderNumber,
          status: OrderStatus.PENDING_PAYMENT,
          subtotalMinor: price.subtotalMinor,
          discountMinor: 0n,
          totalMinor: price.totalMinor,
          currency,
          idempotencyKey: input.idempotencyKey
        }
      });

      await tx.orderItem.createMany({
        data: lines.map((line) => ({
          tenantId: input.tenantId,
          orderId: order.id,
          productId: line.productId,
          planId: line.planId,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalPriceMinor: line.unitPriceMinor * BigInt(line.quantity),
          configuration: line.configuration
        }))
      });

      const items = await tx.orderItem.findMany({
        where: { tenantId: input.tenantId, orderId: order.id },
        orderBy: { createdAt: "asc" }
      });

      return { order: { ...order, items }, duplicate: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existingOrder = await this.db.order.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
        });
        if (existingOrder) {
          const items = await this.db.orderItem.findMany({
            where: { tenantId: input.tenantId, orderId: existingOrder.id },
            orderBy: { createdAt: "asc" }
          });
          return { order: { ...existingOrder, items }, duplicate: true };
        }
      }
      throw error;
    }
  }

  async getById(tenantId: string, orderId: string) {
    if (!tenantId.trim() || !orderId.trim()) throw new Error("Tenant and order IDs are required.");
    const order = await this.db.order.findFirst({
      where: { id: orderId, tenantId }
    });
    if (!order) return null;
    const items = await this.db.orderItem.findMany({
      where: { tenantId, orderId: order.id },
      orderBy: { createdAt: "asc" }
    });
    return { ...order, items };
  }
}
