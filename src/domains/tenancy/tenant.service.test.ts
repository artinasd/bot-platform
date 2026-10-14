import { TenantStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TenantService } from "./tenant.service";

const tenantCreate = vi.fn();
const tenantUpdateMany = vi.fn();

function makeService() {
  return new TenantService({
    tenant: { create: tenantCreate, updateMany: tenantUpdateMany }
  } as never);
}

describe("tenant service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantCreate.mockResolvedValue({ id: "tenant-a" });
    tenantUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("normalizes the slug and applies safe locale defaults when creating a tenant", async () => {
    const service = makeService();

    await service.create({ slug: "  Acme-Shop  ", name: "  Acme Shop  " });

    expect(tenantCreate).toHaveBeenCalledWith({
      data: {
        slug: "acme-shop",
        name: "Acme Shop",
        status: TenantStatus.PENDING,
        settings: {
          create: {
            locale: "fa-IR",
            currency: "IRR",
            timezone: "Asia/Tehran"
          }
        }
      },
      include: { settings: true }
    });
  });

  it.each(["ab", "-abc", "abc-", "has spaces", "Upper Case", "a".repeat(64)])(
    "rejects invalid tenant slug %s before writing",
    async (slug) => {
      await expect(makeService().create({ slug, name: "Tenant" })).rejects.toThrow(/Tenant slug/);
      expect(tenantCreate).not.toHaveBeenCalled();
    }
  );

  it("rejects an empty tenant name before writing", async () => {
    await expect(makeService().create({ slug: "valid-tenant", name: "   " })).rejects.toThrow("Tenant name is required.");
    expect(tenantCreate).not.toHaveBeenCalled();
  });

  it("only activates a pending tenant", async () => {
    await makeService().activate("tenant-a");

    expect(tenantUpdateMany).toHaveBeenCalledWith({
      where: { id: "tenant-a", status: TenantStatus.PENDING },
      data: { status: TenantStatus.ACTIVE }
    });
  });

  it("only suspends an active tenant", async () => {
    await makeService().suspend("tenant-a");

    expect(tenantUpdateMany).toHaveBeenCalledWith({
      where: { id: "tenant-a", status: TenantStatus.ACTIVE },
      data: { status: TenantStatus.SUSPENDED }
    });
  });

  it.each(["activate", "suspend"] as const)("rejects a blank tenant ID for %s", async (operation) => {
    await expect(makeService()[operation]("  ")).rejects.toThrow("Tenant ID is required.");
    expect(tenantUpdateMany).not.toHaveBeenCalled();
  });
});
