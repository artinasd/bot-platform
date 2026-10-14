import { Prisma, PrismaClient } from "@prisma/client";

const TENANT_SCOPED_MODELS = new Set([
  "User",
  "Job",
  "Event",
  "AuditLog",
  "Permission",
  "Role",
  "FeatureFlag",
  "TenantSettings",
  "TenantBranding",
  "Domain",
  "TelegramBot",
  "StaffMember",
  "Customer",
  "CustomerGroup",
  "Reseller",
  "Partner",
  "Product",
  "Plan",
  "Location",
  "VPNServer",
  "VPNPanel",
  "ProviderConnection",
  "Subscription",
  "SubscriptionConfiguration",
  "Order",
  "OrderItem",
  "Payment",
  "PaymentAttempt",
  "PaymentMethod",
  "Wallet",
  "WalletTransaction",
  "Refund",
  "Coupon",
  "Campaign",
  "Referral",
  "Cashback",
  "Commission",
  "Invoice",
  "Expense",
  "AccountingPeriod",
  "SupportTicket",
  "SupportMessage",
  "Broadcast",
  "Notification",
  "MigrationJob",
  "MigrationRecord",
  "ProviderOperation",
  "LedgerEntry",
  "StaffInvitation",
  "TrialRule",
  "CustomerTag"
]);

const UNIQUE_READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow"
]);

const READ_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy"
]);

const UNIQUE_WRITE_OPERATIONS = new Set(["update", "delete", "upsert"]);
const FILTERED_WRITE_OPERATIONS = new Set(["updateMany", "deleteMany"]);

function addTenantToWhere(args: Record<string, unknown>, tenantId: string) {
  const existing = (args.where ?? {}) as Record<string, unknown>;
  args.where = { AND: [existing, { tenantId }] };
}

function addTenantToData(args: Record<string, unknown>, tenantId: string) {
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) {
    args.data = { ...(args.data as Record<string, unknown>), tenantId };
  }
}

export function createTenantClient(prisma: PrismaClient, tenantId: string) {
  if (!tenantId.trim()) {
    throw new Error("A non-empty tenant ID is required to create a tenant-scoped client.");
  }

  return prisma.$extends(
    Prisma.defineExtension({
      name: "tenant-isolation",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !TENANT_SCOPED_MODELS.has(model)) {
              throw new Error(
                `Tenant-scoped client rejected unsupported model access: ${model ?? "unknown"}.`
              );
            }

            const mutableArgs = args as Record<string, unknown>;

            if (READ_OPERATIONS.has(operation) || FILTERED_WRITE_OPERATIONS.has(operation)) {
              addTenantToWhere(mutableArgs, tenantId);
            }

            if (UNIQUE_READ_OPERATIONS.has(operation) || UNIQUE_WRITE_OPERATIONS.has(operation)) {
              const where = mutableArgs.where as Record<string, unknown> | undefined;
              if (!where) throw new Error("Unique lookup or mutation requires a where clause.");
              // Prisma requires a unique selector at the top level for unique operations.
              mutableArgs.where = { ...where, tenantId };
            }

            if (operation === "create") {
              addTenantToData(mutableArgs, tenantId);
            }

            if (operation === "createMany") {
              const data = mutableArgs.data;
              if (Array.isArray(data)) {
                mutableArgs.data = data.map((row) => ({
                  ...(row as Record<string, unknown>),
                  tenantId
                }));
              } else if (data && typeof data === "object") {
                mutableArgs.data = {
                  ...(data as Record<string, unknown>),
                  tenantId
                };
              }
            }

            if (operation === "upsert") {
              if (mutableArgs.create && typeof mutableArgs.create === "object") {
                mutableArgs.create = {
                  ...(mutableArgs.create as Record<string, unknown>),
                  tenantId
                };
              }
              if (mutableArgs.update && typeof mutableArgs.update === "object") {
                mutableArgs.update = {
                  ...(mutableArgs.update as Record<string, unknown>),
                  tenantId
                };
              }
            }

            return query(mutableArgs as never);
          }
        }
      }
    })
  );
}

export type TenantPrismaClient = ReturnType<typeof createTenantClient>;
