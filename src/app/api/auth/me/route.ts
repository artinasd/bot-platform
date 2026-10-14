import { NextRequest, NextResponse } from "next/server";
import { AuthenticationService } from "@/domains/identity/authentication.service";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, { status: 401 });
  }

  try {
    const session = await new AuthenticationService(prisma).currentSession(token);
    if (!session) {
      const response = NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Session is invalid or expired." } }, { status: 401 });
      response.cookies.set({ name: COOKIE_NAME, value: "", httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    const response = NextResponse.json({
      data: {
        user: session.user,
        tenantId: session.tenantId,
        expiresAt: session.expiresAt.toISOString()
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Unable to resolve the current session." } }, { status: 500 });
  }
}
