import { ProviderOperationStatus, type Job, type Prisma, type ProviderOperation } from "@prisma/client";
import { RetryableJobError } from "../../infrastructure/jobs/job-worker";
import { ProviderConnectionCredentialsService, type ActiveProviderCredentials } from "./provider-connection-credentials.service";
import { ProviderOperationService, type ProviderOperationFailureStatus } from "./provider-operation.service";

export type ProviderOperationExecutor = (
  operation: ProviderOperation,
  credentials: ActiveProviderCredentials
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

  const keys = Reflect.ownKeys(payload);
  if (
    Object.getPrototypeOf(payload) !== Object.prototype &&
    Object.getPrototypeOf(payload) !== null
  ) {
    throw new Error("Provider-operation job payload must be a plain object.");
  }
  if (keys.length !== 1 || keys[0] !== "operationId") {
    throw new Error("Provider-operation job payload must contain only operationId.");
  }

  const descriptor = Object.getOwnPropertyDescriptor(payload, "operationId");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Provider-operation job payload requires a data-field operationId.");
  }

  const operationId = descriptor.value as Prisma.JsonValue;
  if (
    typeof operationId !== "string" ||
    !operationId.trim() ||
    operationId !== operationId.trim() ||
    operationId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(operationId)
  ) {
    throw new Error("Provider-operation job payload requires a valid operationId.");
  }
  return operationId;
}

function safeFailureMessage(status: ProviderOperationFailureStatus): string {
  switch (status) {
    case ProviderOperationStatus.RETRYABLE_FAILURE:
      return "Provider confirmed no action was applied; retry is safe.";
    case ProviderOperationStatus.PERMANENT_FAILURE:
      return "Provider action failed permanently.";
    case ProviderOperationStatus.UNKNOWN:
      return "Provider outcome is unknown; reconciliation is required.";
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof ProviderOperationExecutionError &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code;
  }
  return "PROVIDER_OPERATION_FAILED";
}

/**
 * Bridges durable jobs to provider operations. Credentials are resolved from
 * the operation's explicit active tenant connection immediately before the
 * executor is invoked. Unknown outcomes are never retried automatically.
 */
export function createProviderOperationJobHandler(
  service: ProviderOperationService,
  credentialsService: ProviderConnectionCredentialsService,
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

    let credentials: ActiveProviderCredentials;
    try {
      if (!operation.providerConnectionId?.trim()) {
        throw new Error("Provider connection ID is missing.");
      }
      credentials = await credentialsService.getActiveCredentials(
        tenantId,
        operation.providerConnectionId
      );
      if (credentials.connectionId !== operation.providerConnectionId) {
        throw new Error("Resolved provider credentials do not match the operation connection.");
      }
    } catch {
      const message = "Active provider connection could not be resolved; no provider request was sent.";
      const recorded = await service.markFailed(
        tenantId,
        operationId,
        ProviderOperationStatus.PERMANENT_FAILURE,
        message
      );
      if (!recorded) {
        throw new Error("Provider connection failure could not be recorded; no provider request was sent.");
      }
      throw new Error("Provider connection is unavailable; provider action was not executed.");
    }

    let responsePayload: Prisma.InputJsonValue;
    try {
      responsePayload = await execute(operation, credentials);
    } catch (error) {
      const status = error instanceof ProviderOperationExecutionError
        ? error.status
        : ProviderOperationStatus.UNKNOWN;
      const message = safeFailureMessage(status);
      const recorded = await service.markFailed(tenantId, operationId, status, message);
      if (!recorded) {
        throw new Error("Provider operation failure could not be recorded; reconcile its outcome before retrying.");
      }

      if (status === ProviderOperationStatus.RETRYABLE_FAILURE) {
        throw new RetryableJobError(safeErrorCode(error), message);
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
