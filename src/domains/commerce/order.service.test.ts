import { describe, expect, it, vi } from "vitest";
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
  
  it("returns the existing order for a same-customer idempotent retry", async () => {
    const existingOrder = { id: "order-a", tenantId: "tenant-a", customerId: "customer-a", idempotencyKey: "retry-key" };
    const existingItems = [{ id: "item-a", orderId: "order-a" }];
    const db = {
      order: { findFirst: async () => existingOrder },
      orderItem: { findMany: async () => existingItems }
    };
    const service = new OrderService(db as never);

    await expect(service.create({
      tenantId: "tenant-a",
      customerId: "customer-a",
      idempotencyKey: "retry-key",
      items: [{ productId: "product-a", quantity: 1 }]
    })).resolves.toEqual({
      order: { ...existingOrder, items: existingItems },
      duplicate: true
    });
  });

  it("rejects reuse of an idempotency key by a different customer", async () => {
    const existingOrder = { id: "order-a", tenantId: "tenant-a", customerId: "customer-a", idempotencyKey: "retry-key" };
    const orderItemFindMany = async () => [];
    const db = {
      order: { findFirst: async () => existingOrder },
      orderItem: { findMany: orderItemFindMany },
      $transaction: async () => {
        throw new Error("Transaction should not start for a conflicting idempotency key.");
      }
    };
    const service = new OrderService(db as never);

    await expect(service.create({
      tenantId: "tenant-a",
      customerId: "customer-b",
      idempotencyKey: "retry-key",
      items: [{ productId: "product-a", quantity: 1 }]
    })).rejects.toThrow(/already associated with another customer/i);
  });


  it("scopes order retrieval to the requested tenant", async () => {
    const findFirst = vi.fn(async () => null);
    const db = { order: { findFirst } };
    const service = new OrderService(db as never);

    await expect(service.getById("tenant-b", "order-from-tenant-a")).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "order-from-tenant-a", tenantId: "tenant-b" }
    });
  });

  it("rejects missing tenant or order identifiers before database access", async () => {
    const findFirst = vi.fn();
    const service = new OrderService({ order: { findFirst } } as never);

    await expect(service.getById("", "order-a")).rejects.toThrow(/required/);
    await expect(service.getById("tenant-a", " ")).rejects.toThrow(/required/);
    expect(findFirst).not.toHaveBeenCalled();
  });


  it("loads order items only within the order's tenant and ID", async () => {
    const order = { id: "order-a", tenantId: "tenant-a" };
    const items = [{ id: "item-a", orderId: "order-a", tenantId: "tenant-a" }];
    const orderFindFirst = vi.fn(async () => order);
    const itemFindMany = vi.fn(async () => items);
    const service = new OrderService({
      order: { findFirst: orderFindFirst },
      orderItem: { findMany: itemFindMany }
    } as never);

    await expect(service.getById("tenant-a", "order-a")).resolves.toEqual({ ...order, items });
    expect(orderFindFirst).toHaveBeenCalledWith({
      where: { id: "order-a", tenantId: "tenant-a" }
    });
    expect(itemFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", orderId: "order-a" },
      orderBy: { createdAt: "asc" }
    });
  });

});
