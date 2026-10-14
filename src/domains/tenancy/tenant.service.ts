import { TenantStatus, PrismaClient } from "@prisma/client";

export type CreateTenantInput = {
  slug: string;
  name: string;
  locale?: string;
  currency?: string;
  timezone?: string;
};

export class TenantService {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateTenantInput) {
    const slug = input.slug.trim().toLowerCase();
    const name = input.name.trim();

    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug)) {
      throw new Error("Tenant slug must be 3–63 characters and contain only lowercase letters, numbers, or internal hyphens.");
    }
    if (!name) throw new Error("Tenant name is required.");

    return this.db.tenant.create({
      data: {
        slug,
        name,
        status: TenantStatus.PENDING,
        settings: {
          create: {
            locale: input.locale ?? "fa-IR",
            currency: input.currency ?? "IRR",
            timezone: input.timezone ?? "Asia/Tehran"
          }
        }
      },
      include: { settings: true }
    });
  }

  async activate(tenantId: string) {
    if (!tenantId.trim()) throw new Error("Tenant ID is required.");
    return this.db.tenant.updateMany({
      where: { id: tenantId, status: TenantStatus.PENDING },
      data: { status: TenantStatus.ACTIVE }
    });
  }

  async suspend(tenantId: string) {
    if (!tenantId.trim()) throw new Error("Tenant ID is required.");
    return this.db.tenant.updateMany({
      where: { id: tenantId, status: TenantStatus.ACTIVE },
      data: { status: TenantStatus.SUSPENDED }
    });
  }
}
