import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthenticationError, AuthenticationService } from "@/domains/identity/authentication.service";
import { cache } from "@/infrastructure/cache/redis";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  tenantSlug: z.string().trim().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/),
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024)
});

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: NextRequest) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "The login request is invalid." } }, { status: 400 });
  }

  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || "unknown";
  const rateKey = createHash("sha256")
    .update(`${ip.toLowerCase()}:${parsed.data.tenantSlug}:${parsed.data.email.toLowerCase()}`)
    .digest("hex");
  const attempts = await cache.increment(`auth:login:${rateKey}`, WINDOW_SECONDS).catch(() => process.env.NODE_ENV === "production" ? MAX_ATTEMPTS + 1 : 1);
  if (attempts > MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
      { status: 429, headers: { "Retry-After": String(WINDOW_SECONDS) } }
    );
  }

  const userAgent = request.headers.get("user-agent") ?? undefined;
  const service = new AuthenticationService(prisma);
  try {
    const result = await service.login({
      ...parsed.data,
      ipHash: createHash("sha256").update(ip).digest("hex"),
      userAgent
    });

    const response = NextResponse.json({
      data: { user: result.user, tenant: result.tenant, expiresAt: result.expiresAt.toISOString() }
    });
    response.cookies.set({
      name: COOKIE_NAME,
      value: result.token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.expiresAt
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: error.message } }, { status: 401 });
    }
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Unable to complete login." } }, { status: 500 });
  }
}
