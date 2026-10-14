import { Prisma, PrismaClient } from "@prisma/client";

const TENANT_SCOPED_MODELS = new Set([
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

const WRITE_WHERE_OPERATIONS = new Set([
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert"
]);

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

            if (READ_OPERATIONS.has(operation) || WRITE_WHERE_OPERATIONS.has(operation)) {
              addTenantToWhere(mutableArgs, tenantId);
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
              addTenantToData(mutableArgs, tenantId);
              if (mutableArgs.create && typeof mutableArgs.create === "object") {
                mutableArgs.create = {
                  ...(mutableArgs.create as Record<string, unknown>),
                  tenantId
                };
              }
            }

            if (UNIQUE_READ_OPERATIONS.has(operation)) {
              const where = mutableArgs.where as Record<string, unknown> | undefined;
              if (!where) {
                throw new Error("Unique lookup requires a where clause.");
              }

              mutableArgs.where = { AND: [where, { tenantId }] };
            }

            return query(mutableArgs as never);
          }
        }
      }
    })
  );
}

export type TenantPrismaClient = ReturnType<typeof createTenantClient>;
