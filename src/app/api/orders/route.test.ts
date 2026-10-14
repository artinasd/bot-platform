import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  customerFindFirst: vi.fn(),
  orderCreate: vi.fn()
}));

vi.mock("@/domains/identity/authentication.service", () => ({
  AuthenticationService: class {
    currentSession = mocks.currentSession;
    constructor(_db: unknown) {}
  }
}));

vi.mock("@/domains/commerce/order.service", () => ({
  OrderService: class {
    create = mocks.orderCreate;
    constructor(_db: unknown) {}
  }
}));

vi.mock("@/infrastructure/db/prisma", () => ({
  prisma: { customer: { findFirst: mocks.customerFindFirst } }
}));

import { POST } from "./route";

function request(options: {
  withSession?: boolean;
  body?: unknown;
  idempotencyKey?: string;
  rawBody?: string;
} = {}) {
  const headers = new Headers();
  if (options.withSession !== false) headers.set("cookie", "bot_platform_session=session-token");
  if (options.idempotencyKey !== undefined) headers.set("idempotency-key", options.idempotencyKey);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest("http://localhost/api/orders", {
    method: "POST",
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))
  });
}

const validBody = { items: [{ productId: "product-a", quantity: 1 }] };

describe("POST /api/orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests without a session cookie before parsing or database access", async () => {
    const response = await POST(request({ withSession: false, body: validBody, idempotencyKey: "key-a" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(mocks.currentSession).not.toHaveBeenCalled();
    expect(mocks.customerFindFirst).not.toHaveBeenCalled();
    expect(mocks.orderCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid order payloads", async () => {
    const malformed = await POST(request({ rawBody: "{", idempotencyKey: "key-a" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const invalid = await POST(request({ body: { items: [{ productId: "", quantity: 0 }] }, idempotencyKey: "key-a" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.currentSession).not.toHaveBeenCalled();
  });

  it("requires a bounded idempotency key", async () => {
    const missing = await POST(request({ body: validBody }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const tooLong = await POST(request({ body: validBody, idempotencyKey: "x".repeat(201) }));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(mocks.currentSession).not.toHaveBeenCalled();
  });

  it("requires an active tenant session and customer profile", async () => {
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: null });
    const noTenant = await POST(request({ body: validBody, idempotencyKey: "key-a" }));
    expect(noTenant.status).toBe(401);
    expect(await noTenant.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue(null);
    const noCustomer = await POST(request({ body: validBody, idempotencyKey: "key-a" }));
    expect(noCustomer.status).toBe(403);
    expect(await noCustomer.json()).toMatchObject({ error: { code: "CUSTOMER_REQUIRED" } });
    expect(mocks.customerFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", userId: "user-a", status: "ACTIVE" },
      select: { id: true }
    });
    expect(mocks.orderCreate).not.toHaveBeenCalled();
  });

  it("creates an order using the session tenant/customer and returns money as strings", async () => {
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue({ id: "customer-a" });
    mocks.orderCreate.mockResolvedValue({
      duplicate: false,
      order: {
        id: "order-a",
        orderNumber: "BP-1001",
        status: "PENDING",
        subtotalMinor: 1500n,
        discountMinor: 0n,
        totalMinor: 1500n,
        currency: "IRR",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        items: [{
          id: "item-a",
          productId: "product-a",
          planId: null,
          quantity: 1,
          unitPriceMinor: 1500n,
          totalPriceMinor: 1500n,
          configuration: null
        }]
      }
    });

    const response = await POST(request({ body: validBody, idempotencyKey: "key-a" }));
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.orderCreate).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      customerId: "customer-a",
      idempotencyKey: "key-a",
      items: [{ productId: "product-a", quantity: 1, configuration: undefined }]
    });
    expect(body.data.order.totalMinor).toBe("1500");
    expect(body.data.order.items[0].unitPriceMinor).toBe("1500");
  });

  it("returns 200 for a duplicate idempotent order", async () => {
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue({ id: "customer-a" });
    mocks.orderCreate.mockResolvedValue({
      duplicate: true,
      order: {
        id: "order-a",
        orderNumber: "BP-1001",
        status: "PENDING",
        subtotalMinor: 1500n,
        discountMinor: 0n,
        totalMinor: 1500n,
        currency: "IRR",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
        items: []
      }
    });

    const response = await POST(request({ body: validBody, idempotencyKey: "key-a" }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.duplicate).toBe(true);
  });
});
