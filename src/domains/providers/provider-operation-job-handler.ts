import { ProviderOperationStatus, type Job, type Prisma, type ProviderOperation } from "@prisma/client";
import { RetryableJobError } from "../../infrastructure/jobs/job-worker";
import { ProviderOperationService, type ProviderOperationFailureStatus } from "./provider-operation.service";

export type ProviderOperationExecutor = (
  operation: ProviderOperation
) => Promise<Prisma.InputJsonValue>;

export class ProviderOperationExecutionError extends Error {
  readonly status: ProviderOperationFailureStatus;
  readonly code: string;

  constructor(
    status: ProviderOperationFailureStatus,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderOperationExecutionError";
    this.status = status;
    this.code = code.trim() || "PROVIDER_OPERATION_FAILED";
  }
}

function operationIdFromPayload(payload: Prisma.JsonValue): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Provider-operation job payload must be an object.");
  }

  const operationId = (payload as Record<string, Prisma.JsonValue>).operationId;
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new Error("Provider-operation job payload requires an operationId.");
  }
  return operationId;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 2000);
  return "Provider operation failed with an unclassified error.";
}

/**
 * Bridges durable jobs to provider operations. The executor must use the
 * operation's idempotencyKey when supported by the provider. Unknown outcomes
 * are never retried automatically; they require explicit reconciliation.
 */
export function createProviderOperationJobHandler(
  service: ProviderOperationService,
  execute: ProviderOperationExecutor
): (job: Job) => Promise<void> {
  return async (job: Job) => {
    if (!job.tenantId?.trim()) {
      throw new Error("Provider-operation job must belong to a tenant.");
    }

    const operationId = operationIdFromPayload(job.payload);
    const tenantId = job.tenantId;
    const existing = await service.getById(tenantId, operationId);
    if (!existing) throw new Error("Provider operation was not found in this tenant.");

    // Duplicate delivery after a recorded success is safe and does not repeat
    // the external action.
    if (existing.status === ProviderOperationStatus.SUCCEEDED) return;
    if (existing.status === ProviderOperationStatus.UNKNOWN) {
      throw new Error("Provider operation outcome is unknown and must be reconciled before execution.");
    }

    const operation = await service.claim(tenantId, operationId);
    if (!operation) {
      const current = await service.getById(tenantId, operationId);
      if (current?.status === ProviderOperationStatus.SUCCEEDED) return;
      if (current?.status === ProviderOperationStatus.UNKNOWN) {
        throw new Error("Provider operation outcome is unknown and must be reconciled before execution.");
      }
      throw new Error("Provider operation could not be claimed; it may already be running or terminal.");
    }

    let responsePayload: Prisma.InputJsonValue;
    try {
      responsePayload = await execute(operation);
    } catch (error) {
      const status = error instanceof ProviderOperationExecutionError
        ? error.status
        : ProviderOperationStatus.UNKNOWN;
      const message = errorMessage(error);
      const recorded = await service.markFailed(tenantId, operationId, status, message);
      if (!recorded) {
        throw new Error("Provider operation failure could not be recorded; reconcile its outcome before retrying.");
      }

      if (status === ProviderOperationStatus.RETRYABLE_FAILURE) {
        const retryable = error instanceof ProviderOperationExecutionError ? error : undefined;
        throw new RetryableJobError(
          retryable?.code ?? "PROVIDER_OPERATION_RETRYABLE",
          message
        );
      }
      throw new Error(
        status === ProviderOperationStatus.UNKNOWN
          ? "Provider operation outcome is unknown and requires reconciliation."
          : message
      );
    }

    const recorded = await service.markSucceeded(tenantId, operationId, responsePayload);
    if (!recorded) {
      throw new Error("Provider action completed but its success could not be recorded; reconcile before retrying.");
    }
  };
}
