import { NextRequest, NextResponse } from "next/server";
import { AuthenticationService } from "@/domains/identity/authentication.service";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      await new AuthenticationService(prisma).logout(token);
    } catch {
      // Always clear the browser cookie even if the session store is temporarily unavailable.
    }
  }

  const response = NextResponse.json({ data: { loggedOut: true } });
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
