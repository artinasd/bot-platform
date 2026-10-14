import { PrismaClient, RecordStatus, TenantStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError, AuthenticationService } from "./authentication.service";

vi.mock("@/infrastructure/security/password", () => ({
  verifyPassword: vi.fn(async () => true)
}));

const tenant = { id: "tenant-a", slug: "tenant-a", name: "Tenant A", status: TenantStatus.ACTIVE };
const globalUser = {
  id: "user-global",
  tenantId: null,
  email: "person@example.com",
  displayName: "Person",
  passwordHash: "test-hash",
  status: RecordStatus.ACTIVE
};

function makeDb() {
  return {
    tenant: { findFirst: vi.fn() },
    user: { findMany: vi.fn(), update: vi.fn() },
    staffMember: { findFirst: vi.fn() }
  };
}

describe("authentication tenant boundaries", () => {
  let db: ReturnType<typeof makeDb>;
  let service: AuthenticationService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    service = new AuthenticationService(db as unknown as PrismaClient);
  });

  it("rejects login when the requested tenant is inactive or missing", async () => {
    db.tenant.findFirst.mockResolvedValue(null);

    await expect(service.login({
      tenantSlug: "tenant-a",
      email: "person@example.com",
      password: "correct-password"
    })).rejects.toBeInstanceOf(AuthenticationError);

    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("does not let a global user sign into a tenant without active staff membership", async () => {
    db.tenant.findFirst.mockResolvedValue(tenant);
    db.user.findMany.mockResolvedValue([globalUser]);
    db.staffMember.findFirst.mockResolvedValue(null);

    await expect(service.login({
      tenantSlug: " TENANT-A ",
      email: " PERSON@example.com ",
      password: "correct-password"
    })).rejects.toBeInstanceOf(AuthenticationError);

    expect(db.staffMember.findFirst).toHaveBeenCalledWith({
      where: { tenantId: tenant.id, userId: globalUser.id, status: RecordStatus.ACTIVE },
      select: { id: true }
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});
