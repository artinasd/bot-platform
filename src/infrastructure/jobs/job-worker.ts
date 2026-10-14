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

function errorDetails(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof RetryableJobError) {
    return {
      code: error.code,
      message: error.message || "Retryable job failure.",
      retryable: true
    };
  }

  // Unclassified exceptions may happen after an external side effect succeeded.
  // Never retry them automatically: reconcile the outcome or classify the error
  // explicitly in a handler that knows the provider's idempotency guarantees.
  if (error instanceof Error) {
    return { code: "JOB_EXECUTION_UNCERTAIN", message: error.message || "Job execution failed.", retryable: false };
  }

  return { code: "JOB_EXECUTION_UNCERTAIN", message: "Job execution failed with a non-error value.", retryable: false };
}

export class JobWorker {
  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlerRegistry,
    private readonly workerId: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly baseRetryDelayMs = 1_000,
    private readonly maxRetryDelayMs = 5 * 60_000
  ) {
    if (!workerId.trim()) throw new Error("Worker ID is required.");
    if (!Number.isSafeInteger(baseRetryDelayMs) || baseRetryDelayMs <= 0) {
      throw new Error("Base retry delay must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs) {
      throw new Error("Maximum retry delay must be an integer at least as large as the base delay.");
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
        { code: "UNKNOWN_JOB_TYPE", message: `No handler is registered for job type "${job.type}".` },
        undefined,
        this.clock()
      );
      return result.count === 1 ? { status: "failed", jobId: job.id } : { status: "lease-lost", jobId: job.id };
    }

    try {
      await handler(job);
    } catch (error) {
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

    const result = await this.queue.markSucceeded(job.id, this.workerId, this.clock());
    return result.count === 1
      ? { status: "succeeded", jobId: job.id }
      : { status: "lease-lost", jobId: job.id };
  }
}
