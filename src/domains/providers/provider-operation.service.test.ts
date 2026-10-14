import { ProviderOperationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderOperationService } from "./provider-operation.service";

const mocks = vi.hoisted(() => ({
  operationFindFirst: vi.fn(),
  operationCreate: vi.fn(),
  operationUpdateMany: vi.fn(),
  orderFindFirst: vi.fn(),
  itemFindFirst: vi.fn(),
  providerConnectionFindFirst: vi.fn()
}));

function makeService() {
  const tx = {
    providerOperation: {
      findFirst: mocks.operationFindFirst,
      create: mocks.operationCreate
    },
    order: { findFirst: mocks.orderFindFirst },
    orderItem: { findFirst: mocks.itemFindFirst },
    providerConnection: { findFirst: mocks.providerConnectionFindFirst }
  };
  const db = {
    providerOperation: { findFirst: mocks.operationFindFirst, updateMany: mocks.operationUpdateMany },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx))
  };
  return new ProviderOperationService(db as never);
}

const input = {
  tenantId: "tenant-a",
  orderId: "order-a",
  itemId: "item-a",
  providerConnectionId: "connection-a",
  action: "provision",
  idempotencyKey: "provision-order-a-item-a",
  requestPayload: { plan: "basic", seats: 2 }
};

const existingOperation = {
  id: "operation-a",
  tenantId: "tenant-a",
  orderId: "order-a",
  itemId: "item-a",
  providerConnectionId: "connection-a",
  action: "provision",
  idempotencyKey: "provision-order-a-item-a",
  requestPayload: { seats: 2, plan: "basic" },
  status: ProviderOperationStatus.PENDING,
  attempts: 0
};

describe("provider operation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operationFindFirst.mockResolvedValue(null);
    mocks.operationCreate.mockResolvedValue(existingOperation);
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.orderFindFirst.mockResolvedValue({ id: "order-a" });
    mocks.itemFindFirst.mockResolvedValue({ id: "item-a" });
    mocks.providerConnectionFindFirst.mockResolvedValue({ id: "connection-a" });
  });

  it("validates required identifiers before database access", async () => {
    const service = makeService();
    await expect(service.create({ ...input, tenantId: " " })).rejects.toThrow(/Tenant ID is required/);
    expect(mocks.operationFindFirst).not.toHaveBeenCalled();
  });

  it("creates an operation only after tenant-scoped order and item checks", async () => {
    const service = makeService();
    await expect(service.create(input)).resolves.toEqual({
      operation: existingOperation,
      duplicate: false
    });
    expect(mocks.providerConnectionFindFirst).toHaveBeenCalledWith({
      where: { id: "connection-a", tenantId: "tenant-a", status: "ACTIVE" },
      select: { id: true }
    });
    expect(mocks.orderFindFirst).toHaveBeenCalledWith({
      where: { id: "order-a", tenantId: "tenant-a" },
      select: { id: true }
    });
    expect(mocks.itemFindFirst).toHaveBeenCalledWith({
      where: { id: "item-a", tenantId: "tenant-a", orderId: "order-a" },
      select: { id: true }
    });
    expect(mocks.operationCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-a",
        orderId: "order-a",
        itemId: "item-a",
        providerConnectionId: "connection-a",
        action: "provision",
        idempotencyKey: "provision-order-a-item-a",
        requestPayload: { plan: "basic", seats: 2 }
      }
    });
  });

  it("returns a duplicate for an equivalent idempotent request", async () => {
    mocks.operationFindFirst.mockResolvedValue(existingOperation);
    const service = makeService();
    await expect(service.create(input)).resolves.toEqual({
      operation: existingOperation,
      duplicate: true
    });
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rejects idempotency-key reuse with a different payload or operation target", async () => {
    mocks.operationFindFirst.mockResolvedValue(existingOperation);
    const service = makeService();
    await expect(service.create({
      ...input,
      requestPayload: { plan: "premium", seats: 2 }
    })).rejects.toThrow(/different provider operation/);
    await expect(service.create({ ...input, itemId: "another-item" })).rejects.toThrow(/different provider operation/);
    await expect(service.create({ ...input, providerConnectionId: "connection-b" })).rejects.toThrow(/different provider operation/);
  });


  it("rejects an inactive or cross-tenant provider connection", async () => {
    mocks.providerConnectionFindFirst.mockResolvedValue(null);
    const service = makeService();
    await expect(service.create(input)).rejects.toThrow(/Active provider connection was not found in this tenant/);
    expect(mocks.providerConnectionFindFirst).toHaveBeenCalledWith({
      where: { id: "connection-a", tenantId: "tenant-a", status: "ACTIVE" },
      select: { id: true }
    });
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("rejects orders not owned by the requested tenant", async () => {
    mocks.orderFindFirst.mockResolvedValue(null);
    const service = makeService();
    await expect(service.create(input)).rejects.toThrow(/Order not found in this tenant/);
    expect(mocks.itemFindFirst).not.toHaveBeenCalled();
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("does not create an operation for an item outside the specified order and tenant", async () => {
    mocks.itemFindFirst.mockResolvedValue(null);
    const service = makeService();
    await expect(service.create(input)).rejects.toThrow(/Order item not found/);
    expect(mocks.operationCreate).not.toHaveBeenCalled();
  });

  it("claims only pending or retryable operations and increments attempts atomically", async () => {
    mocks.operationFindFirst.mockResolvedValue({ ...existingOperation, status: ProviderOperationStatus.RUNNING, attempts: 1 });
    const service = makeService();
    await service.claim("tenant-a", "operation-a");
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "operation-a",
        tenantId: "tenant-a",
        status: { in: [ProviderOperationStatus.PENDING, ProviderOperationStatus.RETRYABLE_FAILURE] }
      },
      data: {
        status: ProviderOperationStatus.RUNNING,
        attempts: { increment: 1 },
        lastError: null
      }
    });
  });

  it("returns null when another worker already claimed or the operation is not retryable", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    const service = makeService();
    await expect(service.claim("tenant-b", "operation-a")).resolves.toBeNull();
    expect(mocks.operationFindFirst).not.toHaveBeenCalled();
  });

  it("marks success only for a running operation in the requested tenant", async () => {
    const service = makeService();
    await expect(service.markSucceeded("tenant-a", "operation-a", { providerRef: "ref-1" })).resolves.toBe(true);
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-a", status: ProviderOperationStatus.RUNNING },
      data: {
        status: ProviderOperationStatus.SUCCEEDED,
        responsePayload: { providerRef: "ref-1" },
        lastError: null
      }
    });
  });

  it("allows unknown outcomes to be recorded without making them automatically retryable", async () => {
    const service = makeService();
    await expect(service.markFailed("tenant-a", "operation-a", ProviderOperationStatus.UNKNOWN, "Timeout after request")).resolves.toBe(true);
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-a", status: ProviderOperationStatus.RUNNING },
      data: { status: ProviderOperationStatus.UNKNOWN, lastError: "Timeout after request" }
    });
  });

  it("moves only stale running operations for the tenant to UNKNOWN for reconciliation", async () => {
    const service = makeService();
    const staleBefore = new Date("2026-10-14T10:00:00.000Z");

    await expect(service.markExpiredRunningUnknown("tenant-a", staleBefore)).resolves.toBe(1);

    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-a",
        status: ProviderOperationStatus.RUNNING,
        updatedAt: { lt: staleBefore }
      },
      data: {
        status: ProviderOperationStatus.UNKNOWN,
        lastError: "Provider operation exceeded its execution window; outcome must be reconciled before retrying."
      }
    });
  });

  it("validates stale-operation recovery inputs before database access", async () => {
    const service = makeService();

    await expect(service.markExpiredRunningUnknown(" ", new Date())).rejects.toThrow(/Tenant ID is required/);
    await expect(service.markExpiredRunningUnknown("tenant-a", new Date("invalid"))).rejects.toThrow(/valid stale-before date/);
    expect(mocks.operationUpdateMany).not.toHaveBeenCalled();
  });

  it("resolves unknown outcomes only through an explicit reconciliation decision", async () => {
    const service = makeService();
    await expect(service.resolveUnknown("tenant-a", "operation-a", {
      status: ProviderOperationStatus.SUCCEEDED,
      responsePayload: { providerRef: "confirmed-ref" }
    })).resolves.toBe(true);
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-a", status: ProviderOperationStatus.UNKNOWN },
      data: {
        status: ProviderOperationStatus.SUCCEEDED,
        responsePayload: { providerRef: "confirmed-ref" },
        lastError: null
      }
    });
  });

  it("can return an unknown operation to retryable only after reconciliation confirms no side effect", async () => {
    const service = makeService();
    await expect(service.resolveUnknown("tenant-a", "operation-a", {
      status: ProviderOperationStatus.RETRYABLE_FAILURE,
      errorMessage: "Provider confirms request was not applied"
    })).resolves.toBe(true);
    expect(mocks.operationUpdateMany).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-a", status: ProviderOperationStatus.UNKNOWN },
      data: {
        status: ProviderOperationStatus.RETRYABLE_FAILURE,
        lastError: "Provider confirms request was not applied"
      }
    });
  });

  it("does not resolve unknown operations belonging to another tenant or already transitioned", async () => {
    mocks.operationUpdateMany.mockResolvedValue({ count: 0 });
    const service = makeService();
    await expect(service.resolveUnknown("tenant-b", "operation-a", {
      status: ProviderOperationStatus.PERMANENT_FAILURE,
      errorMessage: "Provider rejected request"
    })).resolves.toBe(false);
  });

  it("rejects invalid failure states and empty errors", async () => {
    const service = makeService();
    await expect(service.markFailed("tenant-a", "operation-a", ProviderOperationStatus.SUCCEEDED as never, "bad")).rejects.toThrow(/Invalid provider operation failure status/);
    await expect(service.markFailed("tenant-a", "operation-a", ProviderOperationStatus.UNKNOWN, " ")).rejects.toThrow(/Provider operation error is required/);
  });

  it("rejects invalid target states when resolving an unknown operation", async () => {
    const service = makeService();
    await expect(service.resolveUnknown("tenant-a", "operation-a", {
      status: ProviderOperationStatus.PENDING,
      errorMessage: "must not move back to pending"
    } as never)).rejects.toThrow(/Invalid unknown-operation resolution status/);
    expect(mocks.operationUpdateMany).not.toHaveBeenCalled();
  });

  it("scopes reads to the requested tenant", async () => {
    mocks.operationFindFirst.mockResolvedValue(null);
    const service = makeService();
    await expect(service.getById("tenant-b", "operation-a")).resolves.toBeNull();
    expect(mocks.operationFindFirst).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-b" }
    });
  });
});
