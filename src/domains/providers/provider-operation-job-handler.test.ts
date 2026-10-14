import { ProviderOperationStatus, type Job, type ProviderOperation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderOperationService } from "./provider-operation.service";
import { createProviderOperationJobHandler, ProviderOperationExecutionError } from "./provider-operation-job-handler";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  claim: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  execute: vi.fn()
}));

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  status: ProviderOperationStatus.PENDING,
  idempotencyKey: "operation-key",
  action: "subscription.create",
  requestPayload: { planId: "plan-a" }
} as unknown as ProviderOperation;

const job = {
  id: "job-a",
  tenantId: "tenant-a",
  payload: { operationId: "operation-a" }
} as unknown as Job;

function makeHandler() {
  const service = {
    getById: mocks.getById,
    claim: mocks.claim,
    markSucceeded: mocks.markSucceeded,
    markFailed: mocks.markFailed
  } as unknown as ProviderOperationService;
  return createProviderOperationJobHandler(service, mocks.execute);
}

describe("provider-operation job handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue(operation);
    mocks.claim.mockResolvedValue({ ...operation, status: ProviderOperationStatus.RUNNING });
    mocks.markSucceeded.mockResolvedValue(true);
    mocks.markFailed.mockResolvedValue(true);
    mocks.execute.mockResolvedValue({ providerRef: "ref-a" });
  });

  it("claims the tenant-scoped operation, executes it, and records its response", async () => {
    await expect(makeHandler()(job)).resolves.toBeUndefined();
    expect(mocks.getById).toHaveBeenCalledWith("tenant-a", "operation-a");
    expect(mocks.claim).toHaveBeenCalledWith("tenant-a", "operation-a");
    expect(mocks.execute).toHaveBeenCalledWith({ ...operation, status: ProviderOperationStatus.RUNNING });
    expect(mocks.markSucceeded).toHaveBeenCalledWith("tenant-a", "operation-a", { providerRef: "ref-a" });
  });

  it("does not repeat an already successful operation", async () => {
    mocks.getById.mockResolvedValue({ ...operation, status: ProviderOperationStatus.SUCCEEDED });
    await expect(makeHandler()(job)).resolves.toBeUndefined();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses to execute an operation whose outcome is unknown", async () => {
    mocks.getById.mockResolvedValue({ ...operation, status: ProviderOperationStatus.UNKNOWN });
    await expect(makeHandler()(job)).rejects.toThrow(/must be reconciled/);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("records unclassified executor errors as UNKNOWN rather than retryable", async () => {
    mocks.execute.mockRejectedValue(new Error("Connection dropped after request."));
    await expect(makeHandler()(job)).rejects.toThrow(/requires reconciliation/);
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.UNKNOWN,
      "Connection dropped after request."
    );
  });

  it("schedules a job retry only for explicitly classified retryable provider failures", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.RETRYABLE_FAILURE,
      "PROVIDER_BUSY",
      "Provider confirms no action was applied."
    ));
    await expect(makeHandler()(job)).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "PROVIDER_BUSY"
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.RETRYABLE_FAILURE,
      "Provider confirms no action was applied."
    );
  });

  it("records explicit permanent failures without scheduling a retry", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.PERMANENT_FAILURE,
      "INVALID_PLAN",
      "Provider rejected the plan."
    ));
    await expect(makeHandler()(job)).rejects.toThrow("Provider rejected the plan.");
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.PERMANENT_FAILURE,
      "Provider rejected the plan."
    );
  });

  it("requires a tenant and an operation ID before claiming work", async () => {
    await expect(makeHandler()({ ...job, tenantId: null } as Job)).rejects.toThrow(/belong to a tenant/);
    await expect(makeHandler()({ ...job, payload: {} } as Job)).rejects.toThrow(/operationId/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("does not mark a provider action successful when persistence rejects the transition", async () => {
    mocks.markSucceeded.mockResolvedValue(false);
    await expect(makeHandler()(job)).rejects.toThrow(/reconcile before retrying/);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("does not claim an operation when another worker already owns it", async () => {
    mocks.claim.mockResolvedValue(null);
    mocks.getById
      .mockResolvedValueOnce(operation)
      .mockResolvedValueOnce({ ...operation, status: ProviderOperationStatus.RUNNING });
    await expect(makeHandler()(job)).rejects.toThrow(/already running/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
