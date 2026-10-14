import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OrderService } from "@/domains/commerce/order.service";
import { AuthenticationService } from "@/domains/identity/authentication.service";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";
const orderSchema = z.object({
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(128),
    planId: z.string().trim().min(1).max(128).optional(),
    quantity: z.number().int().min(1).max(10000),
    configuration: z.record(z.string(), z.unknown()).optional()
  })).min(1).max(100)
});

export async function POST(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, { status: 401 });
  }

  const parsed = orderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "The order request is invalid." } }, { status: 400 });
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return NextResponse.json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide an Idempotency-Key header." } }, { status: 400 });
  }

  try {
    const session = await new AuthenticationService(prisma).currentSession(token);
    if (!session || !session.tenantId) {
      return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "A valid tenant session is required." } }, { status: 401 });
    }

    const customer = await prisma.customer.findFirst({
      where: { tenantId: session.tenantId, userId: session.userId, status: "ACTIVE" },
      select: { id: true }
    });
    if (!customer) {
      return NextResponse.json({ error: { code: "CUSTOMER_REQUIRED", message: "An active customer profile is required to place an order." } }, { status: 403 });
    }

    const result = await new OrderService(prisma).create({
      tenantId: session.tenantId,
      customerId: customer.id,
      idempotencyKey,
      items: parsed.data.items.map((item) => ({
        ...item,
        configuration: item.configuration as Record<string, unknown> | undefined
      }))
    });

    const order = result.order;
    const response = NextResponse.json({
      data: {
        duplicate: result.duplicate,
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          subtotalMinor: order.subtotalMinor.toString(),
          discountMinor: order.discountMinor.toString(),
          totalMinor: order.totalMinor.toString(),
          currency: order.currency,
          createdAt: order.createdAt.toISOString(),
          items: "items" in order ? order.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            planId: item.planId,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor.toString(),
            totalPriceMinor: item.totalPriceMinor.toString(),
            configuration: item.configuration
          })) : []
        }
      }
    }, { status: result.duplicate ? 200 : 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: { code: "ORDER_REJECTED", message: "The order could not be created with the supplied items." } }, { status: 400 });
  }
}
