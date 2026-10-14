import { JobStatus, Prisma, PrismaClient, ProviderOperationStatus } from "@prisma/client";
import { PROVIDER_OPERATION_JOB_TYPE } from "./provider-operation-scheduling.service";

const ACTIVE_JOB_STATUSES = [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.RETRY_WAIT];
const DEFAULT_MAX_OPERATION_ATTEMPTS = 8;

export type RetryProviderOperationInput = {
  tenantId: string;
  operationId: string;
};

/**
 * Explicitly requeues an operation only after a prior attempt was classified
 * as safely retryable. UNKNOWN outcomes are never eligible.
 */
export class ProviderOperationRetryService {
  constructor(
    private readonly db: PrismaClient,
    private readonly maxOperationAttempts = DEFAULT_MAX_OPERATION_ATTEMPTS
  ) {
    if (!Number.isSafeInteger(maxOperationAttempts) || maxOperationAttempts <= 0) {
      throw new Error("Maximum provider-operation attempts must be a positive integer.");
    }
  }

  async requeue(input: RetryProviderOperationInput) {
    if (!input.tenantId.trim()) throw new Error("Tenant ID is required.");
    if (!input.operationId.trim()) throw new Error("Provider operation ID is required.");

    return this.db.$transaction(async (tx) => {
      const operation = await tx.providerOperation.findFirst({
        where: { id: input.operationId, tenantId: input.tenantId }
      });
      if (!operation) throw new Error("Provider operation was not found in this tenant.");
      if (operation.status !== ProviderOperationStatus.RETRYABLE_FAILURE) {
        throw new Error("Only explicitly retryable provider operations can be requeued.");
      }
      if (operation.attempts >= this.maxOperationAttempts) {
        throw new Error("Provider operation has exhausted its bounded attempt budget.");
      }

      const activeJob = await tx.job.findFirst({
        where: {
          tenantId: input.tenantId,
          type: PROVIDER_OPERATION_JOB_TYPE,
          payload: { path: ["operationId"], equals: operation.id },
          status: { in: ACTIVE_JOB_STATUSES }
        },
        select: { id: true, status: true }
      });
      if (activeJob) {
        throw new Error(`Provider operation already has an active job (${activeJob.status}).`);
      }

      const moved = await tx.providerOperation.updateMany({
        where: {
          id: operation.id,
          tenantId: input.tenantId,
          status: ProviderOperationStatus.RETRYABLE_FAILURE,
          attempts: operation.attempts
        },
        data: { status: ProviderOperationStatus.PENDING }
      });
      if (moved.count !== 1) {
        throw new Error("Provider operation changed concurrently; reload before requeueing.");
      }

      const remainingAttempts = this.maxOperationAttempts - operation.attempts;
      const idempotencyKey = `provider-operation:${operation.id}:retry:${operation.attempts}`;
      const job = await tx.job.create({
        data: {
          tenantId: operation.tenantId,
          type: PROVIDER_OPERATION_JOB_TYPE,
          payload: { operationId: operation.id },
          idempotencyKey,
          correlationId: operation.id,
          maxAttempts: remainingAttempts,
          status: JobStatus.QUEUED
        }
      });

      return { operation: { ...operation, status: ProviderOperationStatus.PENDING }, job };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}