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
});
