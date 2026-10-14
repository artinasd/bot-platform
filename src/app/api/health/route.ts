import { NextResponse } from "next/server";
import { cache } from "@/infrastructure/cache/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const redisConfigured = cache.mode === "upstash";
  const redisAvailable = redisConfigured ? await cache.isAvailable() : false;

  return NextResponse.json({
    status: "ok",
    service: "bot-platform",
    timestamp: new Date().toISOString(),
    dependencies: {
      redis: redisConfigured ? (redisAvailable ? "available" : "unavailable") : "not-configured"
    }
  }, { status: 200 });
}
