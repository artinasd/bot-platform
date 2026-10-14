import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentSession: vi.fn(),
  customerFindFirst: vi.fn(),
  orderFindFirst: vi.fn(),
  orderItemFindMany: vi.fn()
}));

vi.mock("@/domains/identity/authentication.service", () => ({
  AuthenticationService: class {
    currentSession = mocks.currentSession;
    constructor(_db: unknown) {}
  }
}));

vi.mock("@/infrastructure/db/prisma", () => ({
  prisma: {
    customer: { findFirst: mocks.customerFindFirst },
    order: { findFirst: mocks.orderFindFirst },
    orderItem: { findMany: mocks.orderItemFindMany }
  }
}));

import { GET } from "./route";

function request(withSession = true) {
  return new NextRequest("http://localhost/api/orders/order-a", {
    headers: withSession ? { cookie: "bot_platform_session=session-token" } : {}
  });
}

const context = { params: Promise.resolve({ orderId: "order-a" }) };

describe("GET /api/orders/[orderId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests without a session cookie before database access", async () => {
    const response = await GET(request(false), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(mocks.currentSession).not.toHaveBeenCalled();
    expect(mocks.customerFindFirst).not.toHaveBeenCalled();
  });

  it("rejects invalid tenant sessions", async () => {
    mocks.currentSession.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(mocks.customerFindFirst).not.toHaveBeenCalled();
  });

  it("requires an active customer profile in the session tenant", async () => {
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "CUSTOMER_REQUIRED" } });
    expect(mocks.customerFindFirst).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", userId: "user-a", status: "ACTIVE" },
      select: { id: true }
    });
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
  });

  it("does not reveal an order belonging to another customer or tenant", async () => {
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue({ id: "customer-a" });
    mocks.orderFindFirst.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(mocks.orderFindFirst).toHaveBeenCalledWith({
      where: { id: "order-a", tenantId: "tenant-a", customerId: "customer-a" }
    });
    expect(mocks.orderItemFindMany).not.toHaveBeenCalled();
  });

  it("loads line items only for the authorized tenant and order", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    mocks.currentSession.mockResolvedValue({ userId: "user-a", tenantId: "tenant-a" });
    mocks.customerFindFirst.mockResolvedValue({ id: "customer-a" });
    mocks.orderFindFirst.mockResolvedValue({
      id: "order-a",
      orderNumber: "BP-1001",
      status: "PENDING",
      subtotalMinor: 1500n,
      discountMinor: 0n,
      totalMinor: 1500n,
      currency: "IRR",
      createdAt
    });
    mocks.orderItemFindMany.mockResolvedValue([{
      id: "item-a",
      productId: "product-a",
      planId: null,
      quantity: 1,
      unitPriceMinor: 1500n,
      totalPriceMinor: 1500n,
      configuration: null
    }]);

    const response = await GET(request(), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.orderItemFindMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-a", orderId: "order-a" },
      orderBy: { createdAt: "asc" }
    });
    expect(body.data.order.totalMinor).toBe("1500");
    expect(body.data.order.items).toHaveLength(1);
    expect(body.data.order.items[0].unitPriceMinor).toBe("1500");
  });
});
