import { ProviderOperationStatus, type ProviderOperation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createProviderOperationExecutorRegistry } from "./provider-operation-executor-registry";

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  action: "subscription.create",
  idempotencyKey: "operation-key-a"
} as ProviderOperation;

describe("provider-operation executor registry", () => {
  it("routes an exact registered action to its executor", async () => {
    const execute = vi.fn().mockResolvedValue({ providerRef: "provider-ref-a" });
    const registry = createProviderOperationExecutorRegistry([{ action: "subscription.create", execute }]);
    await expect(registry(operation)).resolves.toEqual({ providerRef: "provider-ref-a" });
    expect(execute).toHaveBeenCalledWith(operation);
  });

  it("fails closed for unregistered actions without invoking an executor", async () => {
    const execute = vi.fn();
    const registry = createProviderOperationExecutorRegistry([{ action: "subscription.create", execute }]);
    await expect(registry({ ...operation, action: "subscription.delete" })).rejects.toMatchObject({
      name: "ProviderOperationExecutionError",
      status: ProviderOperationStatus.PERMANENT_FAILURE,
      code: "PROVIDER_ACTION_UNSUPPORTED"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an empty registry", () => {
    expect(() => createProviderOperationExecutorRegistry([])).toThrow("At least one provider-operation executor must be registered.");
  });

  it.each(["", " ", " subscription.create", "subscription.create "])("rejects non-canonical action registration %j", (action) => {
    expect(() => createProviderOperationExecutorRegistry([{ action, execute: vi.fn() }])).toThrow(/non-empty canonical string/);
  });

  it("rejects duplicate action registrations instead of overwriting", () => {
    expect(() => createProviderOperationExecutorRegistry([
      { action: "subscription.create", execute: vi.fn() },
      { action: "subscription.create", execute: vi.fn() }
    ])).toThrow('Provider-operation action "subscription.create" is already registered.');
  });
});