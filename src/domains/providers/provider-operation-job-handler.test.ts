import { ProviderOperationStatus, type Job, type ProviderOperation } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderOperationService } from "./provider-operation.service";
import { createProviderOperationJobHandler, ProviderOperationExecutionError } from "./provider-operation-job-handler";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  claim: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  renewRunning: vi.fn(),
  execute: vi.fn(),
  getActiveCredentials: vi.fn()
}));

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  providerConnectionId: "connection-a",
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

function makeHandler(heartbeatIntervalMs = 60_000) {
  const service = {
    getById: mocks.getById,
    claim: mocks.claim,
    markSucceeded: mocks.markSucceeded,
    markFailed: mocks.markFailed,
    renewRunning: mocks.renewRunning
  } as unknown as ProviderOperationService;
  const credentialsService = {
    getActiveCredentials: mocks.getActiveCredentials
  } as unknown as import("./provider-connection-credentials.service").ProviderConnectionCredentialsService;
  return createProviderOperationJobHandler(service, credentialsService, mocks.execute, heartbeatIntervalMs);
}

describe("provider-operation job handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue(operation);
    mocks.claim.mockResolvedValue({ ...operation, status: ProviderOperationStatus.RUNNING });
    mocks.markSucceeded.mockResolvedValue(true);
    mocks.markFailed.mockResolvedValue(true);
    mocks.renewRunning.mockResolvedValue(true);
    mocks.execute.mockResolvedValue({ providerRef: "ref-a" });
    mocks.getActiveCredentials.mockResolvedValue({
      connectionId: "connection-a",
      providerType: "TEST",
      credentials: "server-secret",
      config: {}
    });
  });

  it("claims the tenant-scoped operation, resolves its connection, executes, and records its response", async () => {
    await expect(makeHandler()(job)).resolves.toBeUndefined();
    expect(mocks.getById).toHaveBeenCalledWith("tenant-a", "operation-a");
    expect(mocks.claim).toHaveBeenCalledWith("tenant-a", "operation-a");
    expect(mocks.getActiveCredentials).toHaveBeenCalledWith("tenant-a", "connection-a");
    expect(mocks.execute).toHaveBeenCalledWith(
      { ...operation, status: ProviderOperationStatus.RUNNING },
      { connectionId: "connection-a", providerType: "TEST", credentials: "server-secret", config: {} }
    );
    expect(mocks.markSucceeded).toHaveBeenCalledWith("tenant-a", "operation-a", { providerRef: "ref-a" });
  });

  it("does not repeat an already successful operation", async () => {
    mocks.getById.mockResolvedValue({ ...operation, status: ProviderOperationStatus.SUCCEEDED });
    await expect(makeHandler()(job)).resolves.toBeUndefined();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.getActiveCredentials).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses to execute an operation whose outcome is unknown", async () => {
    mocks.getById.mockResolvedValue({ ...operation, status: ProviderOperationStatus.UNKNOWN });
    await expect(makeHandler()(job)).rejects.toThrow(/must be reconciled/);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.getActiveCredentials).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when active tenant credentials cannot be resolved", async () => {
    mocks.getActiveCredentials.mockRejectedValue(new Error("database details must not leak"));
    await expect(makeHandler()(job)).rejects.toThrow(/provider action was not executed/);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.PERMANENT_FAILURE,
      "Active provider connection could not be resolved; no provider request was sent."
    );
  });

  it("fails closed if the credential resolver returns a different connection", async () => {
    mocks.getActiveCredentials.mockResolvedValue({
      connectionId: "connection-from-another-operation",
      providerType: "TEST",
      credentials: "server-secret",
      config: {}
    });
    await expect(makeHandler()(job)).rejects.toThrow(/provider action was not executed/);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.PERMANENT_FAILURE,
      "Active provider connection could not be resolved; no provider request was sent."
    );
  });

  it("fails closed when a legacy operation has no provider connection ID", async () => {
    const legacyOperation = { ...operation, providerConnectionId: "" } as unknown as ProviderOperation;
    mocks.getById.mockResolvedValue(legacyOperation);
    mocks.claim.mockResolvedValue({ ...legacyOperation, status: ProviderOperationStatus.RUNNING });
    await expect(makeHandler()(job)).rejects.toThrow(/provider action was not executed/);
    expect(mocks.getActiveCredentials).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("records unclassified executor errors as UNKNOWN rather than retryable", async () => {
    mocks.execute.mockRejectedValue(new Error("Provider outcome is unknown; reconciliation is required."));
    await expect(makeHandler()(job)).rejects.toThrow(/requires reconciliation/);
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.UNKNOWN,
      "Provider outcome is unknown; reconciliation is required."
    );
  });

  it("schedules a job retry only for explicitly classified retryable provider failures", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.RETRYABLE_FAILURE,
      "PROVIDER_BUSY",
      "Provider confirmed no action was applied; retry is safe."
    ));
    await expect(makeHandler()(job)).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "PROVIDER_BUSY"
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.RETRYABLE_FAILURE,
      "Provider confirmed no action was applied; retry is safe."
    );
  });

  it("records explicit permanent failures without scheduling a retry", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.PERMANENT_FAILURE,
      "INVALID_PLAN",
      "Provider action failed permanently."
    ));
    await expect(makeHandler()(job)).rejects.toThrow("Provider action failed permanently.");
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.PERMANENT_FAILURE,
      "Provider action failed permanently."
    );
  });


  it("does not persist raw provider error details or unsafe error codes", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.PERMANENT_FAILURE,
      "INVALID_PLAN: token=super-secret",
      "Rejected request with authorization: super-secret"
    ));
    await expect(makeHandler()(job)).rejects.toThrow("Provider action failed permanently.");
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "tenant-a",
      "operation-a",
      ProviderOperationStatus.PERMANENT_FAILURE,
      "Provider action failed permanently."
    );
  });

  it("uses a safe fallback code for unclassified retryable error codes", async () => {
    mocks.execute.mockRejectedValue(new ProviderOperationExecutionError(
      ProviderOperationStatus.RETRYABLE_FAILURE,
      "provider busy token=super-secret",
      "Do not expose this detail"
    ));
    await expect(makeHandler()(job)).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "PROVIDER_OPERATION_FAILED",
      message: "Provider confirmed no action was applied; retry is safe."
    });
  });

  it("requires a tenant and an operation ID before claiming work", async () => {
    await expect(makeHandler()({ ...job, tenantId: null } as Job)).rejects.toThrow(/belong to a tenant/);
    await expect(makeHandler()({ ...job, payload: {} } as Job)).rejects.toThrow(/operationId/);
    await expect(makeHandler()({ ...job, payload: { operationId: " operation-a " } } as Job)).rejects.toThrow(/valid operationId/);
    await expect(makeHandler()({ ...job, payload: { operationId: "operation-a", tenantId: "tenant-b" } } as Job)).rejects.toThrow(/only operationId/);
    await expect(makeHandler()({ ...job, payload: { operationId: "operation-a".repeat(30) } } as Job)).rejects.toThrow(/valid operationId/);
    await expect(makeHandler()({ ...job, payload: { operationId: "operation-a\u0000tail" } } as Job)).rejects.toThrow(/valid operationId/);
    await expect(makeHandler()({ ...job, payload: { operationId: "operation-a\u007ftail" } } as Job)).rejects.toThrow(/valid operationId/);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("renews the provider-operation recovery timestamp during a long-running execution", async () => {
    mocks.execute.mockImplementation(async () => new Promise((resolve) => setTimeout(() => resolve({ providerRef: "ref-a" }), 25)));
    await expect(makeHandler(5)(job)).resolves.toBeUndefined();
    expect(mocks.renewRunning).toHaveBeenCalledWith("tenant-a", "operation-a");
  });

  it("does not record success after the provider-operation lease is lost", async () => {
    mocks.renewRunning.mockResolvedValue(false);
    mocks.execute.mockImplementation(async () => new Promise((resolve) => setTimeout(() => resolve({ providerRef: "ref-a" }), 25)));
    await expect(makeHandler(5)(job)).rejects.toThrow(/ownership was lost during execution/);
    expect(mocks.markSucceeded).not.toHaveBeenCalled();
  });

  it("rejects an invalid provider-operation heartbeat interval", () => {
    expect(() => makeHandler(0)).toThrow(/heartbeat interval must be a positive integer/);
    expect(() => makeHandler(300_000)).toThrow(/heartbeat interval must be a positive integer/);
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
    await expect(makeHandler()(job)).rejects.toThrow(/could not be claimed/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
