import { ProviderOperationStatus, PrismaClient } from "@prisma/client";
import { ProviderOperationService } from "./provider-operation.service";

const DEFAULT_STALE_AGE_MS = 5 * 60 * 1000;
const DEFAULT_TENANT_BATCH_SIZE = 500;

export type ProviderOperationRecoveryResult = {
  tenantsScanned: number;
  operationsMarkedUnknown: number;
};

/**
 * Moves expired provider operations to UNKNOWN without retrying side effects.
 * This is a maintenance primitive; it does not run automatically or reconcile
 * provider state. A scheduler may call it periodically with a trusted clock.
 */
export class ProviderOperationRecoveryService {
  constructor(
    private readonly db: PrismaClient,
    private readonly operations: ProviderOperationService,
    private readonly clock: () => Date = () => new Date(),
    private readonly staleAgeMs = DEFAULT_STALE_AGE_MS,
    private readonly tenantBatchSize = DEFAULT_TENANT_BATCH_SIZE
  ) {
    if (!Number.isSafeInteger(staleAgeMs) || staleAgeMs < DEFAULT_STALE_AGE_MS) {
      throw new Error("Provider-operation stale age must be at least five minutes.");
    }
    if (!Number.isSafeInteger(tenantBatchSize) || tenantBatchSize <= 0 || tenantBatchSize > 5_000) {
      throw new Error("Tenant batch size must be between 1 and 5000.");
    }
  }

  async recoverExpiredRunning(): Promise<ProviderOperationRecoveryResult> {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("Recovery clock must return a valid date.");
    }
    const staleBefore = new Date(now.getTime() - this.staleAgeMs);

    // Paginate tenants with stale candidates so tenants beyond the first batch
    // cannot be starved by a permanently full, alphabetically early first page.
    let cursorId: string | undefined;
    let tenantsScanned = 0;
    let operationsMarkedUnknown = 0;

    while (true) {
      const tenants = await this.db.tenant.findMany({
        where: {
          providerOperations: {
            some: {
              status: ProviderOperationStatus.RUNNING,
              updatedAt: { lt: staleBefore }
            }
          }
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: this.tenantBatchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {})
      });

      tenantsScanned += tenants.length;
      for (const tenant of tenants) {
        operationsMarkedUnknown += await this.operations.markExpiredRunningUnknown(
          tenant.id,
          staleBefore
        );
      }

      if (tenants.length < this.tenantBatchSize) break;
      cursorId = tenants[tenants.length - 1]?.id;
      if (!cursorId) break;
    }

    return { tenantsScanned, operationsMarkedUnknown };
  }
}
