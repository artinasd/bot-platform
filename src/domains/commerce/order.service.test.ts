import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";

describe("order service input validation", () => {
  const service = new OrderService({} as never);

  it("rejects missing tenant, customer, and idempotency identifiers before database access", async () => {
    await expect(service.create({
      tenantId: "",
      customerId: "",
      idempotencyKey: "",
      items: [{ productId: "product", quantity: 1 }]
    })).rejects.toThrow(/required/);
  });

  it("rejects an empty order before database access", async () => {
    await expect(service.create({
      tenantId: "tenant",
      customerId: "customer",
      idempotencyKey: "key",
      items: []
    })).rejects.toThrow(/between 1 and 100/);
  });

  it("rejects overly long idempotency keys before database access", async () => {
    await expect(service.create({
      tenantId: "tenant",
      customerId: "customer",
      idempotencyKey: "x".repeat(201),
      items: [{ productId: "product", quantity: 1 }]
    })).rejects.toThrow(/too long/);
  });

  it("rejects a customer that is not owned by the requested tenant", async () => {
    const tx = {
      tenant: { findFirst: async () => ({ id: "tenant-a" }) },
      customer: { findFirst: async () => null },
      product: { findFirst: async () => ({ id: "product-a", priceMinor: 100n, currency: "IRR" }) }
    };
    const db = {
      order: { findFirst: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    };
    const service = new OrderService(db as never);

    await expect(service.create({
      tenantId: "tenant-a",
      customerId: "customer-from-tenant-b",
      idempotencyKey: "cross-tenant-customer",
      items: [{ productId: "product-a", quantity: 1 }]
    })).rejects.toThrow(/customer not found in this tenant/i);
  });

  it("rejects a product that is not owned by the requested tenant", async () => {
    const tx = {
      tenant: { findFirst: async () => ({ id: "tenant-a" }) },
      customer: { findFirst: async () => ({ id: "customer-a" }) },
      product: { findFirst: async () => null }
    };
    const db = {
      order: { findFirst: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    };
    const service = new OrderService(db as never);

    await expect(service.create({
      tenantId: "tenant-a",
      customerId: "customer-a",
      idempotencyKey: "cross-tenant-product",
      items: [{ productId: "product-from-tenant-b", quantity: 1 }]
    })).rejects.toThrow(/product is unavailable in this tenant/i);
  });

  it("rejects a plan that is not attached to the requested tenant's product", async () => {
    const tx = {
      tenant: { findFirst: async () => ({ id: "tenant-a" }) },
      customer: { findFirst: async () => ({ id: "customer-a" }) },
      product: { findFirst: async () => ({ id: "product-a", priceMinor: 100n, currency: "IRR" }) },
      plan: { findFirst: async () => null }
    };
    const db = {
      order: { findFirst: async () => null },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    };
    const service = new OrderService(db as never);

    await expect(service.create({
      tenantId: "tenant-a",
      customerId: "customer-a",
      idempotencyKey: "cross-tenant-plan",
      items: [{ productId: "product-a", planId: "plan-from-tenant-b", quantity: 1 }]
    })).rejects.toThrow(/plan is unavailable for this product/i);
  });
});
