import { JobStatus, ProviderOperationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderOperationRetryService } from "./provider-operation-retry.service";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findOperation: vi.fn(),
  findActiveJob: vi.fn(),
  findRetryGeneration: vi.fn(),
  updateOperation: vi.fn(),
  createJob: vi.fn()
}));

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  status: ProviderOperationStatus.RETRYABLE_FAILURE,
  attempts: 2,
  idempotencyKey: "operation-key-a"
};

const tx = {
  providerOperation: { findFirst: mocks.findOperation, updateMany: mocks.updateOperation },
  job: { findFirst: mocks.findActiveJob, findUnique: mocks.findRetryGeneration, create: mocks.createJob }
};

function makeService(maxAttempts = 8) {
  mocks.transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx));
  return new ProviderOperationRetryService({ $transaction: mocks.transaction } as never, maxAttempts);
}

describe("ProviderOperationRetryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOperation.mockResolvedValue(operation);
    mocks.findActiveJob.mockResolvedValue(null);
    mocks.findRetryGeneration.mockResolvedValue(null);
    mocks.updateOperation.mockResolvedValue({ count: 1 });
    mocks.createJob.mockImplementation(async (args) => ({ id: "job-retry-a", ...args.data }));
  });

  it("atomically moves a retryable operation back to pending and creates a bounded job", async () => {
    const result = await makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" });
    expect(mocks.updateOperation).toHaveBeenCalledWith({
      where: { id: "operation-a", tenantId: "tenant-a", status: ProviderOperationStatus.RETRYABLE_FAILURE, attempts: 2 },
      data: { status: ProviderOperationStatus.PENDING }
    });
    expect(mocks.createJob).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: "tenant-a",
      type: "provider.operation.execute",
      payload: { operationId: "operation-a" },
      idempotencyKey: "provider-operation:operation-a:retry:2",
      correlationId: "operation-a",
      maxAttempts: 6,
      status: JobStatus.QUEUED
    }) });
    expect(result.operation.status).toBe(ProviderOperationStatus.PENDING);
    expect(result.job.id).toBe("job-retry-a");
  });

  it("returns the existing retry generation when a request is repeated after commit", async () => {
    const existingJob = { id: "job-retry-a", status: JobStatus.QUEUED };
    mocks.findOperation.mockResolvedValue({ ...operation, status: ProviderOperationStatus.PENDING });
    mocks.findRetryGeneration.mockResolvedValue(existingJob);
    const result = await makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" });
    expect(result).toEqual({ operation: { ...operation, status: ProviderOperationStatus.PENDING }, job: existingJob, duplicate: true });
    expect(mocks.updateOperation).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
  it("refuses unknown outcomes and does not create a job", async () => {
    mocks.findOperation.mockResolvedValue({ ...operation, status: ProviderOperationStatus.UNKNOWN });
    await expect(makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" })).rejects.toThrow(/Only explicitly retryable/);
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("refuses to requeue while a job is active", async () => {
    mocks.findActiveJob.mockResolvedValue({ id: "job-a", status: JobStatus.RETRY_WAIT });
    await expect(makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" })).rejects.toThrow(/already has an active job/);
    expect(mocks.updateOperation).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("refuses exhausted attempt budgets", async () => {
    mocks.findOperation.mockResolvedValue({ ...operation, attempts: 8 });
    await expect(makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" })).rejects.toThrow(/exhausted/);
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("does not create a job when the operation changed concurrently", async () => {
    mocks.updateOperation.mockResolvedValue({ count: 0 });
    await expect(makeService().requeue({ tenantId: "tenant-a", operationId: "operation-a" })).rejects.toThrow(/changed concurrently/);
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("requires tenant and operation IDs", async () => {
    await expect(makeService().requeue({ tenantId: " ", operationId: "operation-a" })).rejects.toThrow(/Tenant ID is required/);
    await expect(makeService().requeue({ tenantId: "tenant-a", operationId: " " })).rejects.toThrow(/Provider operation ID is required/);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});