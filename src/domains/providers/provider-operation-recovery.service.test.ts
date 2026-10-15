import { ProviderOperationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderOperationRecoveryService } from "./provider-operation-recovery.service";
import { ProviderOperationService } from "./provider-operation.service";

const mocks = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  markExpiredRunningUnknown: vi.fn()
}));

function makeRecovery(overrides: {
  clock?: () => Date;
  staleAgeMs?: number;
  tenantBatchSize?: number;
} = {}) {
  const db = { tenant: { findMany: mocks.tenantFindMany } };
  const operations = { markExpiredRunningUnknown: mocks.markExpiredRunningUnknown };
  return new ProviderOperationRecoveryService(
    db as never,
    operations as unknown as ProviderOperationService,
    overrides.clock ?? (() => new Date("2026-10-14T12:00:00.000Z")),
    overrides.staleAgeMs,
    overrides.tenantBatchSize
  );
}

describe("provider operation recovery service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantFindMany.mockResolvedValue([{ id: "tenant-a" }, { id: "tenant-b" }]);
    mocks.markExpiredRunningUnknown.mockResolvedValue(2);
  });

  it("scans only tenants with stale running operations and uses a five-minute safety cutoff", async () => {
    const recovery = makeRecovery();
    await expect(recovery.recoverExpiredRunning()).resolves.toEqual({
      tenantsScanned: 2, operationsMarkedUnknown: 4
    });
    const staleBefore = new Date("2026-10-14T11:55:00.000Z");
    expect(mocks.tenantFindMany).toHaveBeenCalledWith({
      where: { providerOperations: { some: {
        status: ProviderOperationStatus.RUNNING, updatedAt: { lt: staleBefore }
      } } },
      select: { id: true }, orderBy: { id: "asc" }, take: 500
    });
    expect(mocks.markExpiredRunningUnknown).toHaveBeenNthCalledWith(1, "tenant-a", staleBefore);
    expect(mocks.markExpiredRunningUnknown).toHaveBeenNthCalledWith(2, "tenant-b", staleBefore);
  });

  it("continues past full tenant batches so later tenants are not starved", async () => {
    mocks.tenantFindMany.mockResolvedValueOnce([{ id: "tenant-a" }, { id: "tenant-b" }])
      .mockResolvedValueOnce([{ id: "tenant-c" }]);
    mocks.markExpiredRunningUnknown.mockResolvedValue(1);
    const recovery = makeRecovery({ tenantBatchSize: 2 });
    await expect(recovery.recoverExpiredRunning()).resolves.toEqual({
      tenantsScanned: 3, operationsMarkedUnknown: 3
    });
    expect(mocks.tenantFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      take: 2, cursor: { id: "tenant-b" }, skip: 1
    }));
    expect(mocks.markExpiredRunningUnknown.mock.calls.map(([tenantId]) => tenantId))
      .toEqual(["tenant-a", "tenant-b", "tenant-c"]);
  });

  it("returns zero counts when no tenants need recovery", async () => {
    mocks.tenantFindMany.mockResolvedValue([]);
    await expect(makeRecovery().recoverExpiredRunning()).resolves.toEqual({
      tenantsScanned: 0, operationsMarkedUnknown: 0
    });
    expect(mocks.markExpiredRunningUnknown).not.toHaveBeenCalled();
  });

  it("validates recovery safety limits at construction", () => {
    const db = {} as never;
    const operations = {} as ProviderOperationService;
    expect(() => new ProviderOperationRecoveryService(db, operations, undefined, 1_000))
      .toThrow(/at least five minutes/);
    expect(() => new ProviderOperationRecoveryService(db, operations, undefined, 300_000, 0))
      .toThrow(/between 1 and 5000/);
    expect(() => new ProviderOperationRecoveryService(db, operations, undefined, 300_000, 5_001))
      .toThrow(/between 1 and 5000/);
  });

  it("rejects an invalid recovery clock before database access", async () => {
    const recovery = makeRecovery({ clock: () => new Date("invalid") });
    await expect(recovery.recoverExpiredRunning()).rejects.toThrow(/valid date/);
    expect(mocks.tenantFindMany).not.toHaveBeenCalled();
  });

  it("keeps processing tenant-scoped recovery sequentially", async () => {
    const order: string[] = [];
    mocks.markExpiredRunningUnknown.mockImplementation(async (tenantId: string) => {
      order.push(tenantId); return 1;
    });
    await expect(makeRecovery().recoverExpiredRunning()).resolves.toEqual({
      tenantsScanned: 2, operationsMarkedUnknown: 2
    });
    expect(order).toEqual(["tenant-a", "tenant-b"]);
  });
});
