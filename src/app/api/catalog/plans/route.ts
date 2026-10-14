import { NextRequest, NextResponse } from "next/server";
import { RecordStatus, TenantStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const slugSchema = z.string().trim().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/);

export async function GET(request: NextRequest) {
  const tenantSlug = slugSchema.safeParse(request.nextUrl.searchParams.get("tenant"));
  const productSlug = slugSchema.safeParse(request.nextUrl.searchParams.get("product"));
  if (!tenantSlug.success || !productSlug.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Valid tenant and product slugs are required." } }, { status: 400 });
  }

  const tenant = await prisma.tenant.findFirst({
    where: { slug: tenantSlug.data, status: TenantStatus.ACTIVE },
    select: { id: true, slug: true }
  });
  if (!tenant) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Catalog not found." } }, { status: 404 });

  const product = await prisma.product.findFirst({
    where: { tenantId: tenant.id, slug: productSlug.data, status: RecordStatus.ACTIVE },
    select: { id: true, slug: true, name: true, currency: true }
  });
  if (!product) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Product not found." } }, { status: 404 });

  const plans = await prisma.plan.findMany({
    where: { tenantId: tenant.id, productId: product.id, status: RecordStatus.ACTIVE },
    orderBy: [{ priceMinor: "asc" }, { id: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      priceMinor: true,
      currency: true,
      durationSeconds: true,
      trafficBytes: true,
      unlimitedTraffic: true,
      deviceLimit: true,
      connectionLimit: true,
      configuration: true
    }
  });

  const response = NextResponse.json({
    data: {
      tenant: tenant.slug,
      product,
      plans: plans.map((plan) => ({
        ...plan,
        priceMinor: plan.priceMinor.toString(),
        trafficBytes: plan.trafficBytes?.toString() ?? null
      }))
    }
  });
  response.headers.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  return response;
}
