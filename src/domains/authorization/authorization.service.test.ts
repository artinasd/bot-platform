import { StaffRole, TenantStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertCapability,
  assertTenantAccess,
  authorizeTenantAction,
  AuthorizationError,
  hasCapability,
  TenantContextError
} from "./authorization.service";

const actor = {
  userId: "user_1",
  tenantId: "tenant_a",
  role: StaffRole.SUPPORT
};

describe("authorization service", () => {
  it("grants capabilities assigned to the actor's role", () => {
    expect(hasCapability(actor, "support:manage")).toBe(true);
    expect(hasCapability(actor, "payments:verify")).toBe(false);
  });

  it("allows explicitly granted capabilities", () => {
    expect(hasCapability({ ...actor, explicitPermissions: ["payments:verify"] }, "payments:verify")).toBe(true);
  });

  it("rejects cross-tenant resource access", () => {
    expect(() => assertTenantAccess(actor, { tenantId: "tenant_b", tenantStatus: TenantStatus.ACTIVE })).toThrow(TenantContextError);
  });

  it("rejects inactive tenants", () => {
    expect(() => assertTenantAccess(actor, { tenantId: "tenant_a", tenantStatus: TenantStatus.SUSPENDED })).toThrow(TenantContextError);
  });

  it("rejects a missing capability", () => {
    expect(() => assertCapability(actor, "payments:verify")).toThrow(AuthorizationError);
  });

  it("checks tenant ownership before capabilities", () => {
    expect(() => authorizeTenantAction(actor, { tenantId: "tenant_b", tenantStatus: TenantStatus.ACTIVE }, "support:manage")).toThrow(TenantContextError);
  });
  it("fails closed for unknown runtime capabilities and malformed roles", () => {
    expect(hasCapability(actor, "root:everything" as never)).toBe(false);
    expect(hasCapability({ ...actor, role: "UNKNOWN" as never }, "support:manage")).toBe(false);
  });

  it("does not treat unknown explicit permission strings as capabilities", () => {
    expect(hasCapability({
      ...actor,
      explicitPermissions: ["root:everything", "tenant:read"]
    }, "payments:verify")).toBe(false);
    expect(hasCapability({
      ...actor,
      explicitPermissions: ["root:everything", "tenant:read"]
    }, "tenant:read")).toBe(true);
  });

});
