import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CatalogService } from "@/domains/catalog/catalog.service";
import { prisma } from "@/infrastructure/db/prisma";
import { TenantStatus } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.string().trim().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/);

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(request.nextUrl.searchParams.get("tenant"));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "A valid tenant slug is required." } }, { status: 400 });
  }

  const tenant = await prisma.tenant.findFirst({
    where: { slug: parsed.data, status: TenantStatus.ACTIVE },
    select: { id: true, slug: true, name: true, settings: { select: { currency: true, locale: true } } }
  });
  if (!tenant) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Catalog not found." } }, { status: 404 });
  }

  try {
    const products = await new CatalogService(prisma).listPublishedProducts(tenant.id);
    const response = NextResponse.json({
      data: {
        tenant: { slug: tenant.slug, name: tenant.name, settings: tenant.settings },
        products: products.map((product) => ({
          ...product,
          priceMinor: product.priceMinor.toString()
        }))
      }
    });
    response.headers.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return response;
  } catch {
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Unable to load catalog." } }, { status: 500 });
  }
}
