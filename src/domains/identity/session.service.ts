import { createHash, randomBytes } from "node:crypto";
import { PrismaClient, RecordStatus, TenantStatus } from "@prisma/client";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24;
const MAX_TTL_SECONDS = 60 * 60 * 24 * 30;

export type CreateSessionInput = {
  userId: string;
  tenantId?: string | null;
  ttlSeconds?: number;
  ipHash?: string;
  userAgent?: string;
};

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class SessionService {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateSessionInput) {
    if (!input.userId.trim()) throw new Error("User ID is required.");
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
      throw new Error("Session TTL must be between 60 seconds and 30 days.");
    }

    const user = await this.db.user.findFirst({
      where: { id: input.userId, status: RecordStatus.ACTIVE }
    });
    if (!user) throw new Error("Active user not found.");

    if (input.tenantId) {
      const tenant = await this.db.tenant.findFirst({
        where: { id: input.tenantId, status: TenantStatus.ACTIVE }
      });
      if (!tenant) throw new Error("Active tenant not found.");

      const staffMembership = await this.db.staffMember.findFirst({
        where: { userId: user.id, tenantId: tenant.id, status: RecordStatus.ACTIVE }
      });
      const customerMembership = await this.db.customer.findFirst({
        where: { userId: user.id, tenantId: tenant.id, status: RecordStatus.ACTIVE }
      });
      if (!staffMembership && !customerMembership && user.tenantId !== tenant.id) {
        throw new Error("User does not belong to this tenant.");
      }
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const session = await this.db.session.create({
      data: {
        userId: user.id,
        tenantId: input.tenantId ?? null,
        tokenHash: hashSessionToken(token),
        expiresAt,
        ipHash: input.ipHash,
        userAgent: input.userAgent?.slice(0, 500)
      },
      select: { id: true, userId: true, tenantId: true, expiresAt: true, createdAt: true }
    });

    return { token, session };
  }

  async resolve(token: string) {
    if (!token || token.length > 256) return null;
    const session = await this.db.session.findFirst({
      where: {
        tokenHash: hashSessionToken(token),
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: RecordStatus.ACTIVE },
        OR: [
          { tenantId: null },
          { tenant: { status: TenantStatus.ACTIVE } }
        ]
      },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        expiresAt: true,
        user: { select: { id: true, email: true, phone: true, displayName: true, status: true, tenantId: true } }
      }
    });
    if (!session) return null;

    if (session.tenantId && session.user.tenantId !== session.tenantId) {
      const [staffMembership, customerMembership] = await Promise.all([
        this.db.staffMember.findFirst({
          where: { userId: session.userId, tenantId: session.tenantId, status: RecordStatus.ACTIVE },
          select: { id: true }
        }),
        this.db.customer.findFirst({
          where: { userId: session.userId, tenantId: session.tenantId, status: RecordStatus.ACTIVE },
          select: { id: true }
        })
      ]);
      if (!staffMembership && !customerMembership) {
        await this.db.session.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        return null;
      }
    }

    await this.db.session.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { lastSeenAt: new Date() }
    });

    return session;
  }

  async revoke(token: string): Promise<boolean> {
    if (!token || token.length > 256) return false;
    const result = await this.db.session.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return result.count === 1;
  }

  async revokeAllForUser(userId: string, tenantId?: string | null): Promise<number> {
    if (!userId.trim()) throw new Error("User ID is required.");
    const result = await this.db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(tenantId === undefined ? {} : { tenantId })
      },
      data: { revokedAt: new Date() }
    });
    return result.count;
  }
}
