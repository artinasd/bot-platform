import type { Job } from "@prisma/client";
import { JobQueue } from "./job-queue";

export type JobHandler = (job: Job) => Promise<void> | void;
export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;

export type JobWorkerOutcome =
  | { status: "idle" }
  | { status: "succeeded"; jobId: string }
  | { status: "retry-scheduled"; jobId: string; retryAt: Date }
  | { status: "failed"; jobId: string }
  | { status: "lease-lost"; jobId: string };

export class RetryableJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RetryableJobError";
    this.code = code.trim() || "RETRYABLE_JOB_ERROR";
  }
}

function safeErrorCode(code: string, fallback: string): string {
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback;
}

function errorDetails(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof RetryableJobError) {
    return {
      code: safeErrorCode(error.code, "RETRYABLE_JOB_ERROR"),
      message: "Job handler reported a retryable failure.",
      retryable: true
    };
  }

  // Exception text may contain credentials, provider response bodies, or user data.
  // Never persist it in the durable job record. Unclassified failures may happen
  // after an external side effect, so they remain non-retryable pending reconciliation.
  return {
    code: "JOB_EXECUTION_UNCERTAIN",
    message: "Job execution outcome is uncertain; reconciliation may be required.",
    retryable: false
  };
}

export class JobWorker {
  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlerRegistry,
    private readonly workerId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly baseRetryDelayMs = 1_000,
    private readonly maxRetryDelayMs = 5 * 60_000,
    private readonly leaseRenewalIntervalMs = 60_000
  ) {
    if (!workerId.trim()) throw new Error("Worker ID is required.");
    if (!Number.isSafeInteger(baseRetryDelayMs) || baseRetryDelayMs <= 0) {
      throw new Error("Base retry delay must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs) {
      throw new Error("Maximum retry delay must be an integer at least as large as the base delay.");
    }
    if (
      !Number.isSafeInteger(leaseRenewalIntervalMs) ||
      leaseRenewalIntervalMs <= 0 ||
      leaseRenewalIntervalMs >= 5 * 60_000
    ) {
      throw new Error("Lease renewal interval must be a positive integer shorter than the five-minute job lease.");
    }
  }

  async runNext(): Promise<JobWorkerOutcome> {
    const job = await this.queue.claimNext(this.workerId, this.clock());
    if (!job) return { status: "idle" };

    const handler = Object.hasOwn(this.handlers, job.type) ? this.handlers[job.type] : undefined;
    if (!handler) {
      const result = await this.queue.markFailed(
        job.id,
        this.workerId,
        { code: "UNKNOWN_JOB_TYPE", message: "No handler is registered for this job type." },
        undefined,
        this.clock()
      );
      return result.count === 1 ? { status: "failed", jobId: job.id } : { status: "lease-lost", jobId: job.id };
    }

    let leaseLost = false;
    let heartbeatStopped = false;
    let renewalInFlight: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewalInFlight = renewalInFlight.then(async () => {
        if (heartbeatStopped || leaseLost) return;
        try {
          const renewed = await this.queue.renewLease(job.id, this.workerId, this.clock());
          if (renewed.count !== 1) leaseLost = true;
        } catch {
          // Retry transient renewal failures on the next tick. The queue's
          // lease cutoff still prevents an expired worker from committing.
        }
      });
    }, this.leaseRenewalIntervalMs);
    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      clearInterval(heartbeat);
      await renewalInFlight;
    };

    try {
      await handler(job);
    } catch (error) {
      await stopHeartbeat();
      if (leaseLost) return { status: "lease-lost", jobId: job.id };
      const failedAt = this.clock();
      const details = errorDetails(error);
      const hasAttemptsRemaining = job.attempts < job.maxAttempts;
      const retryAt = details.retryable && hasAttemptsRemaining
        ? new Date(failedAt.getTime() + Math.min(
            this.maxRetryDelayMs,
            this.baseRetryDelayMs * 2 ** Math.min(Math.max(job.attempts - 1, 0), 30)
          ))
        : undefined;
      const result = await this.queue.markFailed(
        job.id,
        this.workerId,
        { code: details.code, message: details.message },
        retryAt,
        failedAt
      );

      if (result.count !== 1) return { status: "lease-lost", jobId: job.id };
      return retryAt
        ? { status: "retry-scheduled", jobId: job.id, retryAt }
        : { status: "failed", jobId: job.id };
    }

    await stopHeartbeat();
    if (leaseLost) return { status: "lease-lost", jobId: job.id };

    const result = await this.queue.markSucceeded(job.id, this.workerId, this.clock());
    return result.count === 1
      ? { status: "succeeded", jobId: job.id }
      : { status: "lease-lost", jobId: job.id };
  }
}
