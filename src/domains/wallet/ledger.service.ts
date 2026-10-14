import { LedgerEntryType, Prisma, PrismaClient } from "@prisma/client";

export type ApplyWalletEntryInput = {
  tenantId: string;
  walletId: string;
  entryType: LedgerEntryType;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  description?: string;
  referenceType?: string;
  referenceId?: string;
};

export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super("Wallet balance is insufficient for this debit.");
    this.name = "InsufficientWalletBalanceError";
  }
}

export class LedgerService {
  constructor(private readonly db: PrismaClient) {}

  async applyWalletEntry(input: ApplyWalletEntryInput) {
    if (!input.tenantId.trim() || !input.walletId.trim()) throw new Error("Tenant and wallet IDs are required.");
    if (!input.idempotencyKey.trim()) throw new Error("Idempotency key is required.");
    if (input.amountMinor <= 0n) throw new Error("Ledger amount must be greater than zero.");
    if (!input.currency.trim()) throw new Error("Currency is required.");

    return this.db.$transaction(async (tx) => {
      const existing = await tx.ledgerEntry.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } }
      });
      if (existing) return { entry: existing, duplicate: true };

      const wallet = await tx.wallet.findFirst({
        where: { id: input.walletId, tenantId: input.tenantId, currency: input.currency, status: "ACTIVE" }
      });
      if (!wallet) throw new Error("Active wallet not found for this tenant and currency.");

      const isDebit = input.entryType === LedgerEntryType.DEBIT || input.entryType === LedgerEntryType.EXPENSE;
      const delta = isDebit ? -input.amountMinor : input.amountMinor;

      if (isDebit) {
        const updated = await tx.wallet.updateMany({
          where: {
            id: wallet.id,
            tenantId: input.tenantId,
            currency: input.currency,
            balanceMinor: { gte: input.amountMinor }
          },
          data: { balanceMinor: { decrement: input.amountMinor } }
        });
        if (updated.count !== 1) throw new InsufficientWalletBalanceError();
      } else {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceMinor: { increment: input.amountMinor } }
        });
      }

      const entry = await tx.ledgerEntry.create({
        data: {
          tenantId: input.tenantId,
          walletId: wallet.id,
          entryType: input.entryType,
          amountMinor: delta,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          description: input.description,
          referenceType: input.referenceType,
          referenceId: input.referenceId
        }
      });

      await tx.walletTransaction.create({
        data: {
          tenantId: input.tenantId,
          walletId: wallet.id,
          type: input.entryType,
          amountMinor: delta,
          currency: input.currency,
          idempotencyKey: `wallet-tx:${input.idempotencyKey}`,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          description: input.description
        }
      });

      return { entry, duplicate: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
