import { ProviderOperationStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "../../infrastructure/jobs/job-queue";
import { ProviderOperationService } from "./provider-operation.service";
import { ProviderOperationSchedulingService, PROVIDER_OPERATION_JOB_TYPE } from "./provider-operation-scheduling.service";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  enqueue: vi.fn()
}));

function makeService() {
  return new ProviderOperationSchedulingService(
    { create: mocks.create } as unknown as ProviderOperationService,
    { enqueue: mocks.enqueue } as unknown as JobQueue
  );
}

const input = {
  tenantId: "tenant-a",
  orderId: "order-a",
  itemId: "item-a",
  action: "provision",
  idempotencyKey: "operation-key-a",
  requestPayload: { plan: "premium" }
};

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  status: ProviderOperationStatus.PENDING
};

describe("provider operation scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ operation, duplicate: false });
    mocks.enqueue.mockResolvedValue({ id: "job-a", status: "QUEUED" });
  });

  it("creates an idempotent operation and schedules a tenant-scoped durable job", async () => {
    const result = await makeService().schedule(input);

    expect(mocks.create).toHaveBeenCalledWith(input);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      type: PROVIDER_OPERATION_JOB_TYPE,
      payload: { operationId: "operation-a" },
      idempotencyKey: "provider-operation:operation-a",
      correlationId: "operation-a"
    });
    expect(result).toMatchObject({ scheduled: true, duplicate: false, job: { id: "job-a" } });
  });

  it("uses a stable operation ID as the job correlation ID", async () => {
    await makeService().schedule(input);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: "operation-a"
    }));
  });

  it("does not schedule an already successful operation", async () => {
    mocks.create.mockResolvedValue({
      operation: { ...operation, status: ProviderOperationStatus.SUCCEEDED },
      duplicate: true
    });

    const result = await makeService().schedule(input);

    expect(result).toMatchObject({ scheduled: false, duplicate: true, job: null });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ProviderOperationStatus.UNKNOWN,
    ProviderOperationStatus.PERMANENT_FAILURE
  ])("does not blindly schedule terminal/unknown operation state %s", async (status) => {
    mocks.create.mockResolvedValue({ operation: { ...operation, status }, duplicate: true });

    const result = await makeService().schedule(input);

    expect(result.scheduled).toBe(false);
    expect(result.job).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("passes bounded scheduling options through to the queue", async () => {
    const runAt = new Date("2026-10-15T12:00:00.000Z");
    await makeService().schedule({ ...input, runAt, maxAttempts: 3 });

    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      runAt,
      maxAttempts: 3
    }));
  });

  it("leaves a created operation recoverable when queue insertion fails", async () => {
    mocks.enqueue.mockRejectedValue(new Error("queue unavailable"));

    await expect(makeService().schedule(input)).rejects.toThrow("queue unavailable");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
