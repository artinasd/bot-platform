import { Prisma, PrismaClient, RecordStatus, ProductType, TenantStatus } from "@prisma/client";

export type CreateProductInput = {
  tenantId: string;
  slug: string;
  name: string;
  description?: string;
  type: ProductType;
  priceMinor: bigint;
  currency?: string;
  config?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
};

export type CreatePlanInput = {
  tenantId: string;
  productId: string;
  slug: string;
  name: string;
  priceMinor: bigint;
  currency?: string;
  durationSeconds?: number;
  trafficBytes?: bigint;
  unlimitedTraffic?: boolean;
  deviceLimit?: number;
  connectionLimit?: number;
  configuration?: Prisma.InputJsonValue;
};

function validateSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(normalized)) {
    throw new Error("Slug must be 3–63 characters and contain only lowercase letters, numbers, or internal hyphens.");
  }
  return normalized;
}

function validateMoney(amount: bigint, currency: string): void {
  if (amount < 0n) throw new Error("Price cannot be negative.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter uppercase code.");
}

export class CatalogService {
  constructor(private readonly db: PrismaClient) {}

  async createProduct(input: CreateProductInput) {
    const slug = validateSlug(input.slug);
    const name = input.name.trim();
    const currency = (input.currency ?? "IRR").toUpperCase();
    if (!input.tenantId.trim() || !name) throw new Error("Tenant ID and product name are required.");
    validateMoney(input.priceMinor, currency);

    const tenant = await this.db.tenant.findFirst({
      where: { id: input.tenantId, status: TenantStatus.ACTIVE },
      select: { id: true }
    });
    if (!tenant) throw new Error("Active tenant not found.");

    return this.db.product.create({
      data: {
        tenantId: tenant.id,
        slug,
        name,
        description: input.description?.trim() || null,
        type: input.type,
        priceMinor: input.priceMinor,
        currency,
        config: input.config ?? {},
        metadata: input.metadata ?? {}
      }
    });
  }

  async createPlan(input: CreatePlanInput) {
    const slug = validateSlug(input.slug);
    const name = input.name.trim();
    const currency = (input.currency ?? "IRR").toUpperCase();
    if (!input.tenantId.trim() || !input.productId.trim() || !name) {
      throw new Error("Tenant ID, product ID, and plan name are required.");
    }
    validateMoney(input.priceMinor, currency);
    for (const [label, value] of [["duration", input.durationSeconds], ["device limit", input.deviceLimit], ["connection limit", input.connectionLimit]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`${label} must be a positive integer.`);
      }
    }
    if (input.trafficBytes !== undefined && input.trafficBytes < 0n) throw new Error("Traffic cannot be negative.");

    const product = await this.db.product.findFirst({
      where: { id: input.productId, tenantId: input.tenantId, status: RecordStatus.ACTIVE },
      select: { id: true, currency: true }
    });
    if (!product) throw new Error("Active product not found in this tenant.");
    if (product.currency !== currency) throw new Error("Plan currency must match the product currency.");

    return this.db.plan.create({
      data: {
        tenantId: input.tenantId,
        productId: product.id,
        slug,
        name,
        priceMinor: input.priceMinor,
        currency,
        durationSeconds: input.durationSeconds,
        trafficBytes: input.trafficBytes,
        unlimitedTraffic: input.unlimitedTraffic ?? false,
        deviceLimit: input.deviceLimit,
        connectionLimit: input.connectionLimit,
        configuration: input.configuration ?? {}
      }
    });
  }

  async listPublishedProducts(tenantId: string) {
    if (!tenantId.trim()) throw new Error("Tenant ID is required.");
    const tenant = await this.db.tenant.findFirst({
      where: { id: tenantId, status: TenantStatus.ACTIVE },
      select: { id: true }
    });
    if (!tenant) throw new Error("Active tenant not found.");

    return this.db.product.findMany({
      where: { tenantId, status: RecordStatus.ACTIVE },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }]
    });
  }

  async listPlans(tenantId: string, productId: string) {
    if (!tenantId.trim() || !productId.trim()) throw new Error("Tenant and product IDs are required.");
    const product = await this.db.product.findFirst({
      where: { id: productId, tenantId, status: RecordStatus.ACTIVE },
      select: { id: true }
    });
    if (!product) throw new Error("Active product not found in this tenant.");

    return this.db.plan.findMany({
      where: { tenantId, productId, status: RecordStatus.ACTIVE },
      orderBy: [{ priceMinor: "asc" }, { id: "asc" }]
    });
  }
}
