import { PrismaClient, RecordStatus, TenantStatus } from "@prisma/client";
import { verifyPassword } from "@/infrastructure/security/password";
import { SessionService } from "./session.service";

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  constructor() {
    super("Email, password, or tenant credentials are invalid.");
    this.name = "AuthenticationError";
  }
}

export class AuthenticationService {
  private readonly sessions: SessionService;

  constructor(private readonly db: PrismaClient) {
    this.sessions = new SessionService(db);
  }

  async login(input: {
    tenantSlug: string;
    email: string;
    password: string;
    ipHash?: string;
    userAgent?: string;
  }) {
    const tenantSlug = input.tenantSlug.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    if (!tenantSlug || !email || !input.password) throw new AuthenticationError();

    const tenant = await this.db.tenant.findFirst({
      where: { slug: tenantSlug, status: TenantStatus.ACTIVE },
      select: { id: true, slug: true, name: true, status: true }
    });
    if (!tenant) throw new AuthenticationError();

    const candidates = await this.db.user.findMany({
      where: {
        email,
        status: RecordStatus.ACTIVE,
        passwordHash: { not: null },
        OR: [{ tenantId: tenant.id }, { tenantId: null }]
      },
      take: 3
    });

    let matchedUser: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (!candidate.passwordHash) continue;
      if (await verifyPassword(input.password, candidate.passwordHash)) {
        const membership = await this.db.staffMember.findFirst({
          where: { tenantId: tenant.id, userId: candidate.id, status: RecordStatus.ACTIVE },
          select: { id: true }
        });
        if (membership || candidate.tenantId === tenant.id) {
          matchedUser = candidate;
          break;
        }
      }
    }

    if (!matchedUser) throw new AuthenticationError();

    const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 86400);
    const created = await this.sessions.create({
      userId: matchedUser.id,
      tenantId: tenant.id,
      ttlSeconds,
      ipHash: input.ipHash,
      userAgent: input.userAgent
    });

    await this.db.user.update({
      where: { id: matchedUser.id },
      data: { lastLoginAt: new Date() }
    });

    return {
      token: created.token,
      expiresAt: created.session.expiresAt,
      user: {
        id: matchedUser.id,
        email: matchedUser.email,
        displayName: matchedUser.displayName
      },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name }
    };
  }

  async currentSession(token: string) {
    return this.sessions.resolve(token);
  }

  async logout(token: string) {
    return this.sessions.revoke(token);
  }
}
