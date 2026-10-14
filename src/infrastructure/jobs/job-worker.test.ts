import type { Job } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue";
import { JobWorker, RetryableJobError } from "./job-worker";

const mocks = vi.hoisted(() => ({
  claimNext: vi.fn(),
  markSucceeded: vi.fn(),
  markFailed: vi.fn(),
  handler: vi.fn()
}));

const job = {
  id: "job-a",
  type: "catalog.sync",
  attempts: 1,
  maxAttempts: 4
} as Job;

function makeWorker(overrides: {
  handlers?: Record<string, (value: Job) => Promise<void> | void>;
  clock?: () => Date;
  baseDelay?: number;
  maxDelay?: number;
} = {}) {
  const queue = {
    claimNext: mocks.claimNext,
    markSucceeded: mocks.markSucceeded,
    markFailed: mocks.markFailed
  } as unknown as JobQueue;

  return new JobWorker(
    queue,
    overrides.handlers ?? { "catalog.sync": mocks.handler },
    "worker-a",
    overrides.clock ?? (() => new Date("2026-10-14T10:00:00.000Z")),
    overrides.baseDelay ?? 1_000,
    overrides.maxDelay ?? 10_000
  );
}

describe("durable job worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimNext.mockResolvedValue(job);
    mocks.markSucceeded.mockResolvedValue({ count: 1 });
    mocks.markFailed.mockResolvedValue({ count: 1 });
    mocks.handler.mockResolvedValue(undefined);
  });

  it("returns idle when no job is due", async () => {
    mocks.claimNext.mockResolvedValue(null);

    await expect(makeWorker().runNext()).resolves.toEqual({ status: "idle" });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("dispatches a registered handler and marks the job succeeded", async () => {
    const worker = makeWorker();
    const completedAt = new Date("2026-10-14T10:00:02.000Z");
    const clock = vi.fn()
      .mockReturnValueOnce(new Date("2026-10-14T10:00:00.000Z"))
      .mockReturnValueOnce(completedAt);
    const timedWorker = makeWorker({ clock });

    await expect(timedWorker.runNext()).resolves.toEqual({ status: "succeeded", jobId: "job-a" });
    expect(mocks.handler).toHaveBeenCalledWith(job);
    expect(mocks.markSucceeded).toHaveBeenCalledWith("job-a", "worker-a", completedAt);
    expect(worker).toBeDefined();
  });

  it("schedules a classified retryable failure with bounded exponential backoff", async () => {
    mocks.handler.mockRejectedValue(new RetryableJobError("PROVIDER_BUSY", "Provider is busy."));
    const failedAt = new Date("2026-10-14T10:00:05.000Z");
    const clock = vi.fn()
      .mockReturnValueOnce(new Date("2026-10-14T10:00:00.000Z"))
      .mockReturnValueOnce(failedAt);

    await expect(makeWorker({ clock, baseDelay: 2_000, maxDelay: 5_000 }).runNext()).resolves.toEqual({
      status: "retry-scheduled",
      jobId: "job-a",
      retryAt: new Date("2026-10-14T10:00:07.000Z")
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "PROVIDER_BUSY", message: "Job handler reported a retryable failure." },
      new Date("2026-10-14T10:00:07.000Z"),
      failedAt
    );
  });

  it("does not automatically retry an unclassified exception with an uncertain side-effect outcome", async () => {
    mocks.handler.mockRejectedValue(new Error("Connection dropped after request."));
    const failedAt = new Date("2026-10-14T10:00:05.000Z");
    const clock = vi.fn()
      .mockReturnValueOnce(new Date("2026-10-14T10:00:00.000Z"))
      .mockReturnValueOnce(failedAt);

    await expect(makeWorker({ clock }).runNext()).resolves.toEqual({ status: "failed", jobId: "job-a" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "JOB_EXECUTION_UNCERTAIN", message: "Job execution outcome is uncertain; reconciliation may be required." },
      undefined,
      failedAt
    );
  });

  it("never persists raw handler exception messages or unsafe retry codes", async () => {
    mocks.handler.mockRejectedValue(new RetryableJobError(
      "PROVIDER_BUSY token=secret",
      "authorization=Bearer super-secret; response body contains private data"
    ));

    await expect(makeWorker().runNext()).resolves.toMatchObject({ status: "retry-scheduled", jobId: "job-a" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "RETRYABLE_JOB_ERROR", message: "Job handler reported a retryable failure." },
      expect.any(Date),
      new Date("2026-10-14T10:00:00.000Z")
    );
  });

  it("does not expose arbitrary exception text for unclassified failures", async () => {
    mocks.handler.mockRejectedValue(new Error("database URL postgres://user:secret@host/private"));

    await expect(makeWorker().runNext()).resolves.toEqual({ status: "failed", jobId: "job-a" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "JOB_EXECUTION_UNCERTAIN", message: "Job execution outcome is uncertain; reconciliation may be required." },
      undefined,
      new Date("2026-10-14T10:00:00.000Z")
    );
  });

  it("does not retry a classified failure after the last allowed attempt", async () => {
    mocks.claimNext.mockResolvedValue({ ...job, attempts: 4, maxAttempts: 4 });
    mocks.handler.mockRejectedValue(new RetryableJobError("TEMP", "Try later."));
    const clock = vi.fn()
      .mockReturnValueOnce(new Date("2026-10-14T10:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-10-14T10:00:05.000Z"));

    await expect(makeWorker({ clock }).runNext()).resolves.toEqual({ status: "failed", jobId: "job-a" });
    expect(mocks.markFailed.mock.calls[0][3]).toBeUndefined();
  });

  it("fails unregistered job types without retrying", async () => {
    mocks.claimNext.mockResolvedValue({ ...job, type: "unknown.action" });

    await expect(makeWorker({ handlers: {} }).runNext()).resolves.toEqual({ status: "failed", jobId: "job-a" });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "UNKNOWN_JOB_TYPE", message: "No handler is registered for this job type." },
      undefined,
      new Date("2026-10-14T10:00:00.000Z")
    );
    expect(mocks.handler).not.toHaveBeenCalled();
  });


  it("does not treat inherited object properties as registered job handlers", async () => {
    mocks.claimNext.mockResolvedValue({ ...job, type: "toString" });

    await expect(makeWorker().runNext()).resolves.toEqual({ status: "failed", jobId: "job-a" });
    expect(mocks.handler).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith(
      "job-a",
      "worker-a",
      { code: "UNKNOWN_JOB_TYPE", message: "No handler is registered for this job type." },
      undefined,
      new Date("2026-10-14T10:00:00.000Z")
    );
  });

  it("reports lease loss rather than claiming success after ownership expires", async () => {
    mocks.markSucceeded.mockResolvedValue({ count: 0 });

    await expect(makeWorker().runNext()).resolves.toEqual({ status: "lease-lost", jobId: "job-a" });
  });

  it("validates worker and retry-delay configuration", () => {
    const queue = {} as JobQueue;
    expect(() => new JobWorker(queue, {}, " ")).toThrow("Worker ID is required.");
    expect(() => new JobWorker(queue, {}, "worker-a", undefined, 0)).toThrow("Base retry delay must be a positive integer.");
    expect(() => new JobWorker(queue, {}, "worker-a", undefined, 2_000, 1_000))
      .toThrow("Maximum retry delay must be an integer at least as large as the base delay.");
  });
});
