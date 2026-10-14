import { JobStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";

const mocks = vi.hoisted(() => ({
  jobUpsert: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  jobUpdateMany: vi.fn(),
  jobFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
  transaction: vi.fn()
}));

function makeQueue() {
  const tx = {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
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

    mocks.jobUpsert.mockResolvedValue({
      id: "job-a",
      tenantId: "tenant-a",
      type: "provider.provision",
      payload: { orderId: "order-a" },
      idempotencyKey: "job-key-a",
      correlationId: "correlation-a",
      runAt,
      maxAttempts: 8,
      status: JobStatus.QUEUED
    });

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

  it("rejects reusing an idempotency key for a different job payload", async () => {
    mocks.jobUpsert.mockResolvedValue({
      id: "job-a",
      tenantId: "tenant-a",
      type: "provider.provision",
      payload: { orderId: "order-a" },
      idempotencyKey: "job-key-a",
      correlationId: "correlation-a",
      runAt: new Date("2026-10-14T10:00:00.000Z"),
      maxAttempts: 8,
      status: JobStatus.QUEUED
    });
    const queue = makeQueue();

    await expect(queue.enqueue({ ...enqueueInput, payload: { orderId: "order-b" } }))
      .rejects.toThrow("Job idempotency key is already associated with a different job.");
  });

  it("accepts the same job payload regardless of object key order", async () => {
    mocks.jobUpsert.mockResolvedValue({
      id: "job-a",
      tenantId: "tenant-a",
      type: "provider.provision",
      payload: { nested: { b: 2, a: 1 }, orderId: "order-a" },
      idempotencyKey: "job-key-a",
      correlationId: "correlation-a",
      runAt: new Date("2026-10-14T10:00:00.000Z"),
      maxAttempts: 8,
      status: JobStatus.QUEUED
    });
    const queue = makeQueue();

    await expect(queue.enqueue({
      ...enqueueInput,
      payload: { orderId: "order-a", nested: { a: 1, b: 2 } }
    })).resolves.toMatchObject({ id: "job-a" });
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

  it("recovers expired worker leases and fails jobs whose attempts are exhausted", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:00:00.000Z");

    await expect(queue.claimNext("worker-a", now)).resolves.toBeNull();

    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [sql, recoveryTime, staleBefore] = mocks.executeRaw.mock.calls[0] as [TemplateStringsArray, Date, Date];
    expect(sql.join(" ")).toContain("WHEN \"attempts\" >= \"maxAttempts\" THEN 'FAILED'::\"JobStatus\"");
    expect(sql.join(" ")).toContain("'WORKER_LEASE_EXPIRED'");
    expect(recoveryTime).toEqual(now);
    expect(staleBefore).toEqual(new Date("2026-10-14T09:55:00.000Z"));
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

  it("renews a running job lease only for its current worker while the lease is live", async () => {
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:03:00.000Z");

    await queue.renewLease("job-a", "worker-a", now);

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-a",
        lockedAt: { gte: new Date("2026-10-14T09:58:00.000Z") }
      },
      data: { lockedAt: now }
    });
  });

  it("does not renew a lease for a worker that no longer owns the job", async () => {
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:03:00.000Z");

    await expect(queue.renewLease("job-a", "worker-old", now)).resolves.toEqual({ count: 0 });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-old",
        lockedAt: { gte: new Date("2026-10-14T09:58:00.000Z") }
      },
      data: { lockedAt: now }
    });
  });

  it("refuses to resurrect an expired lease even if the old worker is still recorded as owner", async () => {
    mocks.jobUpdateMany.mockResolvedValue({ count: 0 });
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:10:00.000Z");

    await expect(queue.renewLease("job-a", "worker-a", now)).resolves.toEqual({ count: 0 });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-a",
        lockedAt: { gte: new Date("2026-10-14T10:05:00.000Z") }
      },
      data: { lockedAt: now }
    });
  });

  it("validates lease renewal identifiers before database access", async () => {
    const queue = makeQueue();

    await expect(queue.renewLease(" ", "worker-a")).rejects.toThrow("Job ID is required.");
    await expect(queue.renewLease("job-a", " ")).rejects.toThrow("Worker ID is required.");
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });

  it("marks success only for the current worker with a live lease", async () => {
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:03:00.000Z");

    await queue.markSucceeded("job-a", "worker-a", now);

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-a",
        lockedAt: { gte: new Date("2026-10-14T09:58:00.000Z") }
      },
      data: {
        status: JobStatus.SUCCEEDED,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        lastErrorCode: null
      }
    });
  });

  it("refuses success from an expired lease even before another worker claims the job", async () => {
    const queue = makeQueue();
    const now = new Date("2026-10-14T10:10:00.000Z");

    await queue.markSucceeded("job-a", "worker-a", now);

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-a",
        lockedAt: { gte: new Date("2026-10-14T10:05:00.000Z") }
      },
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

    const now = new Date("2026-10-14T10:03:00.000Z");
    await queue.markFailed("job-a", "worker-a", { code: "TEMPORARY", message: "Provider unavailable" }, retryAt, now);

    const ownership = {
      id: "job-a",
      status: JobStatus.RUNNING,
      lockedBy: "worker-a",
      lockedAt: { gte: new Date("2026-10-14T09:58:00.000Z") }
    };
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({ where: ownership });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: ownership,
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

    const now = new Date("2026-10-14T10:03:00.000Z");
    await queue.markFailed("job-a", "worker-a", {
      code: "E".repeat(150),
      message: "M".repeat(2200)
    }, new Date("2026-10-14T10:05:00.000Z"), now);

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "job-a",
        status: JobStatus.RUNNING,
        lockedBy: "worker-a",
        lockedAt: { gte: new Date("2026-10-14T09:58:00.000Z") }
      },
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

    await expect(queue.markFailed(
      "job-a",
      "worker-old",
      { code: "TEMP", message: "stale" },
      undefined,
      new Date("2026-10-14T10:03:00.000Z")
    )).resolves.toEqual({ count: 0 });
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled();
  });
});
