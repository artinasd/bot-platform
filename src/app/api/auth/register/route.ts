import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma, RecordStatus, TenantStatus } from "@prisma/client";
import { z } from "zod";
import { cache } from "@/infrastructure/cache/redis";
import { prisma } from "@/infrastructure/db/prisma";
import { hashPassword } from "@/infrastructure/security/password";
import { hashSessionToken } from "@/domains/identity/session.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const registrationSchema = z.object({
  tenantSlug: z.string().trim().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(1024),
  displayName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).optional()
});

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 60 * 60;

export async function POST(request: NextRequest) {
  const parsed = registrationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "The registration request is invalid." } }, { status: 400 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateKey = createHash("sha256").update(`${ip.toLowerCase()}:${parsed.data.tenantSlug}`).digest("hex");
  const attempts = await cache.increment(`auth:register:${rateKey}`, WINDOW_SECONDS)
    .catch(() => process.env.NODE_ENV === "production" ? MAX_ATTEMPTS + 1 : 1);
  if (attempts > MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many registration attempts. Try again later." } },
      { status: 429, headers: { "Retry-After": String(WINDOW_SECONDS) } }
    );
  }

  const tenant = await prisma.tenant.findFirst({
    where: { slug: parsed.data.tenantSlug, status: TenantStatus.ACTIVE },
    select: { id: true, slug: true, name: true }
  });
  if (!tenant) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Registration is unavailable for this tenant." } }, { status: 404 });
  }

  const email = parsed.data.email.toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);
  const token = randomBytes(32).toString("base64url");
  const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 86400);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 60 * 60 * 24 * 30) {
    return NextResponse.json({ error: { code: "CONFIGURATION_ERROR", message: "Session configuration is invalid." } }, { status: 500 });
  }
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const userAgent = request.headers.get("user-agent")?.slice(0, 500);
  const ipHash = createHash("sha256").update(ip).digest("hex");

  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          phone: parsed.data.phone?.trim() || null,
          passwordHash,
          displayName: parsed.data.displayName.trim(),
          status: RecordStatus.ACTIVE
        },
        select: { id: true, email: true, phone: true, displayName: true }
      });

      await tx.customer.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          phone: user.phone,
          displayName: user.displayName,
          status: RecordStatus.ACTIVE
        }
      });

      await tx.session.create({
        data: {
          userId: user.id,
          tenantId: tenant.id,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipHash,
          userAgent
        }
      });

      return user;
    });

    const response = NextResponse.json({
      data: {
        user: created,
        tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
        expiresAt: expiresAt.toISOString()
      }
    }, { status: 201 });
    response.cookies.set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: { code: "ACCOUNT_EXISTS", message: "An account with these details already exists." } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Unable to create the account." } }, { status: 500 });
  }
}
