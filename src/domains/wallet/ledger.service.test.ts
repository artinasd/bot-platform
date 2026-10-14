import { LedgerEntryType, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsufficientWalletBalanceError, LedgerService } from "./ledger.service";

const mocks = vi.hoisted(() => ({
  ledgerFindUnique: vi.fn(),
  walletFindFirst: vi.fn(),
  walletUpdateMany: vi.fn(),
  walletUpdate: vi.fn(),
  ledgerCreate: vi.fn(),
  walletTransactionCreate: vi.fn(),
  transaction: vi.fn()
}));

function makeService() {
  const tx = {
    ledgerEntry: { findUnique: mocks.ledgerFindUnique, create: mocks.ledgerCreate },
    wallet: {
      findFirst: mocks.walletFindFirst,
      updateMany: mocks.walletUpdateMany,
      update: mocks.walletUpdate
    },
    walletTransaction: { create: mocks.walletTransactionCreate }
  };
  const db = {
    $transaction: vi.fn(async (
      callback: (transaction: typeof tx) => Promise<unknown>,
      options: { isolationLevel: Prisma.TransactionIsolationLevel }
    ) => {
      mocks.transaction(options);
      return callback(tx);
    })
  };
  return new LedgerService(db as never);
}

const input = {
  tenantId: "tenant-a",
  walletId: "wallet-a",
  entryType: LedgerEntryType.DEBIT,
  amountMinor: 250n,
  currency: "IRR",
  idempotencyKey: "debit-key"
};

const wallet = {
  id: "wallet-a",
  tenantId: "tenant-a",
  currency: "IRR",
  status: "ACTIVE",
  balanceMinor: 1000n
};

describe("wallet ledger service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ledgerFindUnique.mockResolvedValue(null);
    mocks.walletFindFirst.mockResolvedValue(wallet);
    mocks.walletUpdateMany.mockResolvedValue({ count: 1 });
    mocks.walletUpdate.mockResolvedValue(wallet);
    mocks.ledgerCreate.mockResolvedValue({ id: "entry-a", amountMinor: -250n });
    mocks.walletTransactionCreate.mockResolvedValue({ id: "wallet-tx-a" });
  });

  it("rejects invalid amounts and missing idempotency keys before database access", async () => {
    const service = makeService();

    await expect(service.applyWalletEntry({ ...input, amountMinor: 0n })).rejects.toThrow(/greater than zero/);
    await expect(service.applyWalletEntry({ ...input, amountMinor: -1n })).rejects.toThrow(/greater than zero/);
    await expect(service.applyWalletEntry({ ...input, idempotencyKey: " " })).rejects.toThrow(/Idempotency key is required/);
    expect(mocks.ledgerFindUnique).not.toHaveBeenCalled();
  });

  it("returns the existing ledger entry for a repeated tenant idempotency key", async () => {
    const existing = { id: "entry-existing", tenantId: "tenant-a", idempotencyKey: "debit-key" };
    mocks.ledgerFindUnique.mockResolvedValue(existing);
    const service = makeService();

    await expect(service.applyWalletEntry(input)).resolves.toEqual({ entry: existing, duplicate: true });
    expect(mocks.ledgerFindUnique).toHaveBeenCalledWith({
      where: { tenantId_idempotencyKey: { tenantId: "tenant-a", idempotencyKey: "debit-key" } }
    });
    expect(mocks.walletFindFirst).not.toHaveBeenCalled();
    expect(mocks.walletUpdateMany).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("rejects a wallet not active in the requested tenant and currency", async () => {
    mocks.walletFindFirst.mockResolvedValue(null);
    const service = makeService();

    await expect(service.applyWalletEntry(input)).rejects.toThrow(/Active wallet not found/);
    expect(mocks.walletFindFirst).toHaveBeenCalledWith({
      where: { id: "wallet-a", tenantId: "tenant-a", currency: "IRR", status: "ACTIVE" }
    });
    expect(mocks.walletUpdateMany).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("rejects a debit when the conditional balance update finds insufficient funds", async () => {
    mocks.walletUpdateMany.mockResolvedValue({ count: 0 });
    const service = makeService();

    await expect(service.applyWalletEntry(input)).rejects.toBeInstanceOf(InsufficientWalletBalanceError);
    expect(mocks.walletUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "wallet-a",
        tenantId: "tenant-a",
        currency: "IRR",
        balanceMinor: { gte: 250n }
      },
      data: { balanceMinor: { decrement: 250n } }
    });
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
    expect(mocks.walletTransactionCreate).not.toHaveBeenCalled();
  });

  it("records a successful debit in both ledgers inside a serializable transaction", async () => {
    const service = makeService();

    await expect(service.applyWalletEntry({
      ...input,
      description: "Order debit",
      referenceType: "Order",
      referenceId: "order-a"
    })).resolves.toEqual({ entry: { id: "entry-a", amountMinor: -250n }, duplicate: false });

    expect(mocks.transaction).toHaveBeenCalledWith({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
    expect(mocks.ledgerCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-a",
        walletId: "wallet-a",
        entryType: LedgerEntryType.DEBIT,
        amountMinor: -250n,
        currency: "IRR",
        idempotencyKey: "debit-key",
        description: "Order debit",
        referenceType: "Order",
        referenceId: "order-a"
      }
    });
    expect(mocks.walletTransactionCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-a",
        walletId: "wallet-a",
        type: LedgerEntryType.DEBIT,
        amountMinor: -250n,
        currency: "IRR",
        idempotencyKey: "wallet-tx:debit-key",
        description: "Order debit",
        referenceType: "Order",
        referenceId: "order-a"
      }
    });
  });

  it("credits the wallet balance for credit entries", async () => {
    const service = makeService();

    await service.applyWalletEntry({ ...input, entryType: LedgerEntryType.CREDIT });
    expect(mocks.walletUpdate).toHaveBeenCalledWith({
      where: { id: "wallet-a" },
      data: { balanceMinor: { increment: 250n } }
    });
    expect(mocks.walletUpdateMany).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amountMinor: 250n, entryType: LedgerEntryType.CREDIT })
    }));
  });
});
