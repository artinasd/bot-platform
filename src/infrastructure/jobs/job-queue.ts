import { JobStatus, Prisma, PrismaClient } from "@prisma/client";

export type EnqueueJobInput = {
  tenantId?: string | null;
  type: string;
  payload: Prisma.InputJsonValue;
  idempotencyKey: string;
  correlationId: string;
  runAt?: Date;
  maxAttempts?: number;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export class JobQueue {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(input: EnqueueJobInput) {
    if (!input.type.trim()) throw new Error("Job type is required.");
    if (!input.idempotencyKey.trim()) throw new Error("Job idempotency key is required.");
    if (!input.correlationId.trim()) throw new Error("Job correlation ID is required.");
    if (input.maxAttempts !== undefined && (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0)) {
      throw new Error("Job max attempts must be a positive integer.");
    }

    const job = await this.db.job.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        tenantId: input.tenantId ?? null,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 8,
        status: JobStatus.QUEUED
      },
      update: {}
    });

    // An idempotency-key collision must not silently alias a different task.
    // Omitted runAt is intentionally not compared: retries naturally happen later.
    const sameRequest =
      job.tenantId === (input.tenantId ?? null) &&
      job.type === input.type &&
      stableJson(job.payload) === stableJson(input.payload) &&
      job.correlationId === input.correlationId &&
      job.maxAttempts === (input.maxAttempts ?? 8) &&
      (input.runAt === undefined || job.runAt.getTime() === input.runAt.getTime());

    if (!sameRequest) {
      throw new Error("Job idempotency key is already associated with a different job.");
    }

    return job;
  }

  async claimNext(workerId: string, now = new Date()) {
    if (!workerId.trim()) throw new Error("Worker ID is required.");

    return this.db.$transaction(async (tx) => {
      const staleBefore = new Date(now.getTime() - 5 * 60 * 1000);

      // Recover leases abandoned by workers that crashed or timed out.
      // The previous claim already counted as an attempt, so exhausted jobs fail here.
      await tx.$executeRaw`
        UPDATE "Job"
        SET
          "status" = CASE
            WHEN "attempts" >= "maxAttempts" THEN 'FAILED'::"JobStatus"
            ELSE 'RETRY_WAIT'::"JobStatus"
          END,
          "runAt" = ${now},
          "lockedAt" = NULL,
          "lockedBy" = NULL,
          "lastErrorCode" = 'WORKER_LEASE_EXPIRED',
          "lastError" = 'Worker lease expired before the job was completed.'
        WHERE "status" = 'RUNNING'
          AND "lockedAt" IS NOT NULL
          AND "lockedAt" < ${staleBefore}
      `;

      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Job"
        WHERE "status" IN ('QUEUED', 'RETRY_WAIT')
          AND "runAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY "runAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;

      const candidate = candidates[0];
      if (!candidate) return null;

      const claimed = await tx.job.updateMany({
        where: { id: candidate.id, status: { in: [JobStatus.QUEUED, JobStatus.RETRY_WAIT] } },
        data: {
          status: JobStatus.RUNNING,
          lockedAt: now,
          lockedBy: workerId,
          attempts: { increment: 1 }
        }
      });

      if (claimed.count !== 1) return null;
      return tx.job.findUnique({ where: { id: candidate.id } });
    });
  }

  async renewLease(jobId: string, workerId: string, now = new Date()) {
    if (!jobId.trim()) throw new Error("Job ID is required.");
    if (!workerId.trim()) throw new Error("Worker ID is required.");

    // A worker may renew only an unexpired lease. This prevents a delayed
    // worker from reviving its lease after the recovery cutoff has passed.
    const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
    return this.db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        lockedAt: { gte: leaseCutoff }
      },
      data: { lockedAt: now }
    });
  }

  async markSucceeded(jobId: string, workerId: string, now = new Date()) {
    const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
    return this.db.job.updateMany({
      where: {
        id: jobId,
        status: JobStatus.RUNNING,
        lockedBy: workerId,
        lockedAt: { gte: leaseCutoff }
      },
      data: { status: JobStatus.SUCCEEDED, lockedAt: null, lockedBy: null, lastError: null, lastErrorCode: null }
    });
  }

  async markFailed(
    jobId: string,
    workerId: string,
    error: { code: string; message: string },
    retryAt?: Date,
    now = new Date()
  ) {
    const leaseCutoff = new Date(now.getTime() - 5 * 60 * 1000);
    const ownership = {
      id: jobId,
      status: JobStatus.RUNNING,
      lockedBy: workerId,
      lockedAt: { gte: leaseCutoff }
    };
    const job = await this.db.job.findFirst({ where: ownership });
    if (!job) return { count: 0 };

    const retryable = job.attempts < job.maxAttempts && retryAt !== undefined;
    return this.db.job.updateMany({
      where: ownership,
      data: {
        status: retryable ? JobStatus.RETRY_WAIT : JobStatus.FAILED,
        runAt: retryable ? retryAt : job.runAt,
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: error.code.slice(0, 120),
        lastError: error.message.slice(0, 2000)
      }
    });
  }
}
