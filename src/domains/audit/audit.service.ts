import { Prisma, PrismaClient } from "@prisma/client";

export type AuditRecordInput = {
  tenantId?: string | null;
  actorType: "USER" | "STAFF" | "SYSTEM" | "PROVIDER";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  previousState?: Prisma.InputJsonValue;
  newState?: Prisma.InputJsonValue;
  source: string;
  correlationId: string;
};

export class AuditService {
  constructor(private readonly db: PrismaClient) {}

  async record(input: AuditRecordInput) {
    for (const [name, value] of Object.entries({
      action: input.action,
      resourceType: input.resourceType,
      source: input.source,
      correlationId: input.correlationId
    })) {
      if (!value.trim()) throw new Error(`Audit ${name} is required.`);
    }

    return this.db.auditLog.create({
      data: {
        tenantId: input.tenantId ?? null,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        previousState: input.previousState,
        newState: input.newState,
        source: input.source,
        correlationId: input.correlationId
      }
    });
  }
}
