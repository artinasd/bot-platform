import { NextRequest, NextResponse } from "next/server";
import { AuthenticationService } from "@/domains/identity/authentication.service";
import { prisma } from "@/infrastructure/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "bot_platform_session";

export async function GET(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, { status: 401 });
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
      return NextResponse.json({ error: { code: "CUSTOMER_REQUIRED", message: "An active customer profile is required." } }, { status: 403 });
    }

    const { orderId } = await context.params;
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId: session.tenantId, customerId: customer.id }
    });
    if (!order) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Order not found." } }, { status: 404 });
    }

    const items = await prisma.orderItem.findMany({
      where: { tenantId: session.tenantId, orderId: order.id },
      orderBy: { createdAt: "asc" }
    });

    const response = NextResponse.json({
      data: {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          subtotalMinor: order.subtotalMinor.toString(),
          discountMinor: order.discountMinor.toString(),
          totalMinor: order.totalMinor.toString(),
          currency: order.currency,
          createdAt: order.createdAt.toISOString(),
          items: items.map((item) => ({
            id: item.id,
            productId: item.productId,
            planId: item.planId,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor.toString(),
            totalPriceMinor: item.totalPriceMinor.toString(),
            configuration: item.configuration
          }))
        }
      }
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "Unable to load the order." } }, { status: 500 });
  }
}
