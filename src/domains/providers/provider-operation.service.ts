import { Prisma, PrismaClient, ProviderOperationStatus, RecordStatus } from "@prisma/client";

export type CreateProviderOperationInput = {
  tenantId: string;
  orderId: string;
  itemId: string;
  providerConnectionId: string;
  action: string;
  idempotencyKey: string;
  requestPayload?: Prisma.InputJsonValue;
};

export type ProviderOperationFailureStatus =
  | typeof ProviderOperationStatus.RETRYABLE_FAILURE
  | typeof ProviderOperationStatus.PERMANENT_FAILURE
  | typeof ProviderOperationStatus.UNKNOWN;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRequired(value: string, label: string, maxLength = 200) {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (value.length > maxLength) throw new Error(`${label} is too long.`);
}

function assertSameRequest(existing: {
  orderId: string;
  itemId: string;
  providerConnectionId: string;
  action: string;
  requestPayload: unknown;
}, input: CreateProviderOperationInput, requestPayload: Prisma.InputJsonValue) {
  if (
    existing.orderId !== input.orderId ||
    existing.itemId !== input.itemId ||
    existing.providerConnectionId !== input.providerConnectionId ||
    existing.action !== input.action ||
    stableJson(existing.requestPayload) !== stableJson(requestPayload)
  ) {
    throw new Error("Idempotency key is already associated with a different provider operation.");
  }
}

export class ProviderOperationService {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateProviderOperationInput) {
    validateRequired(input.tenantId, "Tenant ID");
    validateRequired(input.orderId, "Order ID");
    validateRequired(input.itemId, "Order item ID");
    validateRequired(input.providerConnectionId, "Provider connection ID");
    validateRequired(input.action, "Provider action", 100);
    validateRequired(input.idempotencyKey, "Idempotency key");

    const requestPayload = input.requestPayload ?? {};
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.providerOperation.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
        });
        if (existing) {
          assertSameRequest(existing, input, requestPayload);
          return { operation: existing, duplicate: true };
        }

        const connection = await tx.providerConnection.findFirst({
          where: {
            id: input.providerConnectionId,
            tenantId: input.tenantId,
            status: RecordStatus.ACTIVE
          },
          select: { id: true }
        });
        if (!connection) {
          throw new Error("Active provider connection was not found in this tenant.");
        }

        const order = await tx.order.findFirst({
          where: { id: input.orderId, tenantId: input.tenantId },
          select: { id: true }
        });
        if (!order) throw new Error("Order not found in this tenant.");

        const item = await tx.orderItem.findFirst({
          where: { id: input.itemId, tenantId: input.tenantId, orderId: input.orderId },
          select: { id: true }
        });
        if (!item) throw new Error("Order item not found for this order and tenant.");

        const operation = await tx.providerOperation.create({
          data: {
            tenantId: input.tenantId,
            orderId: input.orderId,
            itemId: input.itemId,
            providerConnectionId: input.providerConnectionId,
            action: input.action,
            idempotencyKey: input.idempotencyKey,
            requestPayload
          }
        });
        return { operation, duplicate: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.db.providerOperation.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }
        });
        if (existing) {
          assertSameRequest(existing, input, requestPayload);
          return { operation: existing, duplicate: true };
        }
      }
      throw error;
    }
  }

  async getById(tenantId: string, operationId: string) {
    validateRequired(tenantId, "Tenant ID");
    validateRequired(operationId, "Provider operation ID");
    return this.db.providerOperation.findFirst({
      where: { id: operationId, tenantId }
    });
  }

  async claim(tenantId: string, operationId: string) {
    validateRequired(tenantId, "Tenant ID");
    validateRequired(operationId, "Provider operation ID");

    const claimed = await this.db.providerOperation.updateMany({
      where: {
        id: operationId,
        tenantId,
        status: { in: [ProviderOperationStatus.PENDING, ProviderOperationStatus.RETRYABLE_FAILURE] }
      },
      data: {
        status: ProviderOperationStatus.RUNNING,
        attempts: { increment: 1 },
        lastError: null
      }
    });
    if (claimed.count !== 1) return null;

    return this.db.providerOperation.findFirst({
      where: { id: operationId, tenantId, status: ProviderOperationStatus.RUNNING }
    });
  }

  async markSucceeded(
    tenantId: string,
    operationId: string,
    responsePayload: Prisma.InputJsonValue = {}
  ) {
    validateRequired(tenantId, "Tenant ID");
    validateRequired(operationId, "Provider operation ID");

    const result = await this.db.providerOperation.updateMany({
      where: { id: operationId, tenantId, status: ProviderOperationStatus.RUNNING },
      data: {
        status: ProviderOperationStatus.SUCCEEDED,
        responsePayload,
        lastError: null
      }
    });
    return result.count === 1;
  }

  async markExpiredRunningUnknown(tenantId: string, staleBefore: Date) {
    validateRequired(tenantId, "Tenant ID");
    if (!(staleBefore instanceof Date) || Number.isNaN(staleBefore.getTime())) {
      throw new Error("A valid stale-before date is required.");
    }

    // A timed-out request may already have taken effect at the provider.
    // Move it to UNKNOWN so a worker cannot blindly issue the side effect again.
    const result = await this.db.providerOperation.updateMany({
      where: {
        tenantId,
        status: ProviderOperationStatus.RUNNING,
        updatedAt: { lt: staleBefore }
      },
      data: {
        status: ProviderOperationStatus.UNKNOWN,
        lastError: "Provider operation exceeded its execution window; outcome must be reconciled before retrying."
      }
    });
    return result.count;
  }

  async resolveUnknown(
    tenantId: string,
    operationId: string,
    resolution:
      | { status: typeof ProviderOperationStatus.SUCCEEDED; responsePayload?: Prisma.InputJsonValue }
      | { status: typeof ProviderOperationStatus.RETRYABLE_FAILURE | typeof ProviderOperationStatus.PERMANENT_FAILURE; errorMessage: string }
  ) {
    validateRequired(tenantId, "Tenant ID");
    validateRequired(operationId, "Provider operation ID");

    const isSuccess = resolution.status === ProviderOperationStatus.SUCCEEDED;
    const isFailure =
      resolution.status === ProviderOperationStatus.RETRYABLE_FAILURE ||
      resolution.status === ProviderOperationStatus.PERMANENT_FAILURE;
    if (!isSuccess && !isFailure) {
      throw new Error("Invalid unknown-operation resolution status.");
    }

    const safeResolutionError = resolution.status === ProviderOperationStatus.RETRYABLE_FAILURE
      ? "Reconciliation confirmed the provider action was not applied; retry is permitted."
      : "Reconciliation confirmed the provider action failed permanently.";

    const data: Prisma.ProviderOperationUpdateManyMutationInput =
      resolution.status === ProviderOperationStatus.SUCCEEDED
        ? {
            status: ProviderOperationStatus.SUCCEEDED,
            responsePayload: resolution.responsePayload ?? {},
            lastError: null
          }
        : {
            status: resolution.status,
            lastError: safeResolutionError
          };

    if (
      resolution.status !== ProviderOperationStatus.SUCCEEDED &&
      !resolution.errorMessage.trim()
    ) {
      throw new Error("Reconciliation error message is required.");
    }

    if (
      resolution.status !== ProviderOperationStatus.SUCCEEDED &&
      resolution.errorMessage.length > 2000
    ) {
      throw new Error("Reconciliation error message is too long.");
    }

    const result = await this.db.providerOperation.updateMany({
      where: { id: operationId, tenantId, status: ProviderOperationStatus.UNKNOWN },
      data
    });
    return result.count === 1;
  }

  async markFailed(
    tenantId: string,
    operationId: string,
    status: ProviderOperationFailureStatus,
    errorMessage: string
  ) {
    validateRequired(tenantId, "Tenant ID");
    validateRequired(operationId, "Provider operation ID");
    validateRequired(errorMessage, "Provider operation error", 2000);
    if (![
      ProviderOperationStatus.RETRYABLE_FAILURE,
      ProviderOperationStatus.PERMANENT_FAILURE,
      ProviderOperationStatus.UNKNOWN
    ].includes(status)) {
      throw new Error("Invalid provider operation failure status.");
    }

    const safeFailureMessage = status === ProviderOperationStatus.RETRYABLE_FAILURE
      ? "Provider confirmed no action was applied; retry is safe."
      : status === ProviderOperationStatus.PERMANENT_FAILURE
        ? "Provider action failed permanently."
        : "Provider outcome is unknown; reconciliation is required.";

    const result = await this.db.providerOperation.updateMany({
      where: { id: operationId, tenantId, status: ProviderOperationStatus.RUNNING },
      data: { status, lastError: safeFailureMessage }
    });
    return result.count === 1;
  }
}
