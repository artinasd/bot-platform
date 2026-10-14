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

export class JobQueue {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(input: EnqueueJobInput) {
    if (!input.type.trim()) throw new Error("Job type is required.");
    if (!input.idempotencyKey.trim()) throw new Error("Job idempotency key is required.");
    if (!input.correlationId.trim()) throw new Error("Job correlation ID is required.");

    return this.db.job.upsert({
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
  }

  async claimNext(workerId: string, now = new Date()) {
    if (!workerId.trim()) throw new Error("Worker ID is required.");

    return this.db.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Job"
        WHERE "status" IN ('QUEUED', 'RETRY_WAIT')
          AND "runAt" <= ${now}
          AND ("lockedAt" IS NULL OR "lockedAt" < ${new Date(now.getTime() - 5 * 60 * 1000)})
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

  async markSucceeded(jobId: string, workerId: string) {
    return this.db.job.updateMany({
      where: { id: jobId, status: JobStatus.RUNNING, lockedBy: workerId },
      data: { status: JobStatus.SUCCEEDED, lockedAt: null, lockedBy: null, lastError: null, lastErrorCode: null }
    });
  }

  async markFailed(jobId: string, workerId: string, error: { code: string; message: string }, retryAt?: Date) {
    const job = await this.db.job.findFirst({ where: { id: jobId, status: JobStatus.RUNNING, lockedBy: workerId } });
    if (!job) return { count: 0 };

    const retryable = job.attempts < job.maxAttempts && retryAt !== undefined;
    return this.db.job.updateMany({
      where: { id: jobId, status: JobStatus.RUNNING, lockedBy: workerId },
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
