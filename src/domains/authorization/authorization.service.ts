import { StaffRole, TenantStatus } from "@prisma/client";

export type Capability =
  | "tenant:read"
  | "tenant:update"
  | "staff:read"
  | "staff:manage"
  | "catalog:read"
  | "catalog:write"
  | "orders:read"
  | "orders:manage"
  | "payments:read"
  | "payments:verify"
  | "wallet:read"
  | "wallet:manage"
  | "subscriptions:read"
  | "subscriptions:manage"
  | "customers:read"
  | "customers:manage"
  | "support:read"
  | "support:manage"
  | "marketing:manage"
  | "resellers:manage"
  | "accounting:read"
  | "accounting:manage"
  | "reports:read"
  | "audit:read"
  | "settings:manage";

export type AuthorizationActor = {
  userId: string;
  tenantId: string;
  role: StaffRole;
  explicitPermissions?: readonly string[];
};

export type AuthorizationResource = {
  tenantId: string;
  tenantStatus: TenantStatus;
};

const roleCapabilities: Record<StaffRole, readonly Capability[]> = {
  OWNER: [
    "tenant:read", "tenant:update", "staff:read", "staff:manage",
    "catalog:read", "catalog:write", "orders:read", "orders:manage",
    "payments:read", "payments:verify", "wallet:read", "wallet:manage",
    "subscriptions:read", "subscriptions:manage", "customers:read", "customers:manage",
    "support:read", "support:manage", "marketing:manage", "resellers:manage",
    "accounting:read", "accounting:manage", "reports:read", "audit:read", "settings:manage"
  ],
  ADMINISTRATOR: [
    "tenant:read", "tenant:update", "staff:read", "staff:manage",
    "catalog:read", "catalog:write", "orders:read", "orders:manage",
    "payments:read", "payments:verify", "wallet:read", "wallet:manage",
    "subscriptions:read", "subscriptions:manage", "customers:read", "customers:manage",
    "support:read", "support:manage", "marketing:manage", "resellers:manage",
    "accounting:read", "accounting:manage", "reports:read", "audit:read", "settings:manage"
  ],
  FINANCE: ["tenant:read", "orders:read", "payments:read", "payments:verify", "wallet:read", "wallet:manage", "accounting:read", "accounting:manage", "reports:read"],
  SUPPORT: ["tenant:read", "orders:read", "subscriptions:read", "customers:read", "support:read", "support:manage"],
  OPERATOR: ["tenant:read", "catalog:read", "orders:read", "orders:manage", "subscriptions:read", "subscriptions:manage", "customers:read", "support:read"],
  MARKETING: ["tenant:read", "catalog:read", "customers:read", "marketing:manage", "reports:read"],
  RESELLER_MANAGER: ["tenant:read", "catalog:read", "orders:read", "customers:read", "resellers:manage", "reports:read"],
  READONLY: ["tenant:read", "catalog:read", "orders:read", "payments:read", "wallet:read", "subscriptions:read", "customers:read", "support:read", "accounting:read", "reports:read", "audit:read"]
};

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  constructor(message = "The actor is not authorized to perform this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class TenantContextError extends Error {
  readonly statusCode = 404;
  constructor() {
    super("Tenant context is invalid or unavailable.");
    this.name = "TenantContextError";
  }
}

export function assertTenantAccess(actor: AuthorizationActor, resource: AuthorizationResource): void {
  if (!actor.userId.trim() || !actor.tenantId.trim() || actor.tenantId !== resource.tenantId) {
    throw new TenantContextError();
  }

  if (resource.tenantStatus !== TenantStatus.ACTIVE) {
    throw new TenantContextError();
  }
}

export function hasCapability(actor: AuthorizationActor, capability: Capability): boolean {
  const granted = new Set<string>([
    ...roleCapabilities[actor.role],
    ...(actor.explicitPermissions ?? [])
  ]);
  return granted.has(capability);
}

export function assertCapability(actor: AuthorizationActor, capability: Capability): void {
  if (!hasCapability(actor, capability)) {
    throw new AuthorizationError(`Missing required capability: ${capability}.`);
  }
}

export function authorizeTenantAction(
  actor: AuthorizationActor,
  resource: AuthorizationResource,
  capability: Capability
): void {
  assertTenantAccess(actor, resource);
  assertCapability(actor, capability);
}
