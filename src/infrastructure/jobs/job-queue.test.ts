import { JobStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";

const mocks = vi.hoisted(() => ({
  jobUpsert: vi.fn(),
  queryRaw: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
  transaction: vi.fn()
}));

function makeQueue() {
  const tx = {
    $queryRaw: mocks.queryRaw,
    job: { updateMany: mocks.jobUpdateMany, findUnique: mocks.jobFindUnique }
  };
  const db = {
    job: {
      upsert: mocks.jobUpsert,
      updateMany: mocks.jobUpdateMany,
      findFirst: mocks.jobFindFirst
    },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      mocks.transaction();
      return callback(tx);
    })
  };
  return new JobQueue(db as never);
}

const enqueueInput = {
  tenantId: "tenant-a",
  type: "provider.provision",
  payload: { orderId: "order-a" },
  idempotencyKey: "job-key-a",
  correlationId: "correlation-a"
};

describe("durable job queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobUpsert.mockResolvedValue({ id: "job-a", status: JobStatus.QUEUED });
    mocks.queryRaw.mockResolvedValue([{ id: "job-a" }]);
    mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.jobFindUnique.mockResolvedValue({ id: "job-a", status: JobStatus.RUNNING, attempts: 1 });
    mocks.jobFindFirst.mockResolvedValue({
      id: "job-a",
      status: JobStatus.RUNNING,
      attempts: 1,
      maxAttempts: 8,
      runAt: new Date("2026-01-01T00:00:00.000Z")
    });
  });

  it("validates job type, idempotency key, and correlation ID before enqueueing", async () => {
    const queue = makeQueue();

    await expect(queue.enqueue({ ...enqueueInput, type: " " })).rejects.toThrow("Job type is required.");
    await expect(queue.enqueue({ ...enqueueInput, idempotencyKey: " " })).rejects.toThrow("Job idempotency key is required.");
    await expect(queue.enqueue({ ...enqueueInput, correlationId: " " })).rejects.toThrow("Job correlation ID is required.");
    await expect(queue.enqueue({ ...enqueueInput, maxAttempts: 0 })).rejects.toThrow("Job max attempts must be a positive integer.");
    await expect(queue.enqueue({ ...enqueueInput, maxAttempts: -1 })).rejects.toThrow("Job max attempts must be a positive integer.");
    await expect(queue.enqueue({ ...enqueueInput, maxAttempts: 1.5 })).rejects.toThrow("Job max attempts must be a positive integer.");
    expect(mocks.jobUpsert).not.toHaveBeenCalled();
  });

  it("enqueues with defaults and preserves idempotency through upsert", async () => {
    const queue = makeQueue();
    const runAt = new Date("2026-10-14T10:00:00.000Z");

    await queue.enqueue({ ...enqueueInput, runAt });

    expect(mocks.jobUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "job-key-a" },
      create: {
        tenantId: "tenant-a",
        type: "provider.provision",
        payload: { orderId: "order-a" },
        idempotencyKey: "job-key-a",
        correlationId: "correlation-a",
        runAt,
        maxAttempts: 8,
        status: JobStatus.QUEUED
      },
      update: {}
    });
  });

  it("rejects an empty worker ID before opening a claim transaction", async () => {
    const queue = makeQueue();

    await expect(queue.claimNext(" ")).rejects.toThrow("Worker ID is required.");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns null when no due job is available", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const queue = makeQueue();

    await expect(queue.claimNext("worker-a", new Date("2026-10-14T10:00:00.000Z"))).resolves.toBeNull();
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("claims one available job and increments its attempt count", async () => {
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:00:00.000Z");

    await expect(queue.claimNext("worker-a", now)).resolves.toEqual({
      id: "job-a",
      status: JobStatus.RUNNING,
      attempts: 1
    });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-a", status: { in: [JobStatus.QUEUED, JobStatus.RETRY_WAIT] } },
      data: {
        status: JobStatus.RUNNING,
        lockedAt: now,
        lockedBy: "worker-a",
        attempts: { increment: 1 }
      }
    });
    expect(mocks.jobFindUnique).toHaveBeenCalledWith({ where: { id: "job-a" } });
  });

  it("does not return a job when the conditional claim loses a race", async () => {
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    const queue = makeQueue();

    await expect(queue.claimNext("worker-a")).resolves.toBeNull();
    expect(mocks.jobFindUnique).not.toHaveBeenCalled();
  });

  it("marks success only for the worker that currently owns the running job", async () => {
    const queue = makeQueue();

    await queue.markSucceeded("job-a", "worker-a");

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-a", status: JobStatus.RUNNING, lockedBy: "worker-a" },
      data: {
        status: JobStatus.SUCCEEDED,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        lastErrorCode: null
      }
    });
  });

  it("schedules a retryable failure only while attempts remain", async () => {
    const queue = makeQueue();
    const retryAt = new Date("2026-10-14T10:05:00.000Z");

    await queue.markFailed("job-a", "worker-a", { code: "TEMPORARY", message: "Provider unavailable" }, retryAt);

    expect(mocks.jobFindFirst).toHaveBeenCalledWith({
      where: { id: "job-a", status: JobStatus.RUNNING, lockedBy: "worker-a" }
    });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-a", status: JobStatus.RUNNING, lockedBy: "worker-a" },
      data: {
        status: JobStatus.RETRY_WAIT,
        runAt: retryAt,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: "TEMPORARY",
        lastError: "Provider unavailable"
      }
    });
  });

  it("marks the job failed after the final attempt and bounds stored error details", async () => {
    mocks.jobFindFirst.mockResolvedValue({
      id: "job-a",
      status: JobStatus.RUNNING,
      attempts: 8,
      maxAttempts: 8,
      runAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const queue = makeQueue();

    await queue.markFailed("job-a", "worker-a", {
      code: "E".repeat(150),
      message: "M".repeat(2200)
    }, new Date("2026-10-14T10:05:00.000Z"));

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: "job-a", status: JobStatus.RUNNING, lockedBy: "worker-a" },
      data: {
        status: JobStatus.FAILED,
        runAt: new Date("2026-01-01T00:00:00.000Z"),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: "E".repeat(120),
        lastError: "M".repeat(2000)
      }
    });
  });

  it("does not mutate a job when the reporting worker no longer owns it", async () => {
    mocks.jobFindFirst.mockResolvedValue(null);
    const queue = makeQueue();

    await expect(queue.markFailed("job-a", "worker-old", { code: "TEMP", message: "stale" })).resolves.toEqual({ count: 0 });
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });
});
