import { JobStatus, ProviderOperationStatus } from "@prisma/client";
import type { CreateProviderOperationInput } from "./provider-operation.service";
import { ProviderOperationService } from "./provider-operation.service";
import { JobQueue } from "../../infrastructure/jobs/job-queue";

export const PROVIDER_OPERATION_JOB_TYPE = "provider.operation.execute";

export type ScheduleProviderOperationInput = CreateProviderOperationInput & {
  runAt?: Date;
  maxAttempts?: number;
};

export type ScheduleProviderOperationResult = {
  operation: Awaited<ReturnType<ProviderOperationService["create"]>>["operation"];
  duplicate: boolean;
  job: Awaited<ReturnType<JobQueue["enqueue"]>> | null;
  scheduled: boolean;
};

/**
 * Persists a provider operation and ensures its durable job exists.
 *
 * These writes are intentionally idempotent but are not one database
 * transaction: if enqueueing fails after operation creation, a caller may
 * safely repeat the same request to complete scheduling. A terminal or
 * unknown operation is never scheduled for blind execution.
 */
export class ProviderOperationSchedulingService {
  constructor(
    private readonly operations: ProviderOperationService,
    private readonly jobs: JobQueue
  ) {}

  async schedule(input: ScheduleProviderOperationInput): Promise<ScheduleProviderOperationResult> {
    const created = await this.operations.create(input);
    const operation = created.operation;

    if (
      operation.status === ProviderOperationStatus.SUCCEEDED ||
      operation.status === ProviderOperationStatus.UNKNOWN ||
      operation.status === ProviderOperationStatus.PERMANENT_FAILURE
    ) {
      return { ...created, job: null, scheduled: false };
    }

    const job = await this.jobs.enqueue({
      tenantId: operation.tenantId,
      type: PROVIDER_OPERATION_JOB_TYPE,
      payload: { operationId: operation.id },
      idempotencyKey: `provider-operation:${operation.id}`,
      // Stable across repeated requests; caller-specific correlation IDs are
      // not persisted on ProviderOperation and therefore cannot be replayed.
      correlationId: operation.id,
      ...(input.runAt ? { runAt: input.runAt } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {})
    });

    if (job.status === JobStatus.FAILED || job.status === JobStatus.CANCELLED) {
      throw new Error(
        `Provider operation job is already terminal (${job.status}); explicit requeue is required.`
      );
    }
    if (job.status === JobStatus.SUCCEEDED && operation.status !== ProviderOperationStatus.SUCCEEDED) {
      throw new Error("Provider operation job succeeded while the operation is not successful; reconcile before proceeding.");
    }

    return { ...created, job, scheduled: true };
  }
}
