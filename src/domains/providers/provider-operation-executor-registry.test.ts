import { ProviderOperationStatus, type ProviderOperation } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProviderOperationExecutorRegistry } from "./provider-operation-executor-registry";
import { createStrictProviderRequestPayloadValidator } from "./provider-operation-request-schema";

const operation = {
  id: "operation-a",
  tenantId: "tenant-a",
  action: "subscription.create",
  idempotencyKey: "operation-key-a",
  providerConnectionId: "connection-a"
} as ProviderOperation;

const credentials = {
  connectionId: "connection-a",
  providerType: "TEST",
  credentials: "secret",
  config: {}
};

describe("provider-operation executor registry", () => {
  it("routes an exact provider type and action with resolved credentials", async () => {
    const execute = vi.fn().mockResolvedValue({ providerRef: "provider-ref-a" });
    const registry = createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute }
    ]);
    await expect(registry(operation, credentials)).resolves.toEqual({ providerRef: "provider-ref-a" });
    expect(execute).toHaveBeenCalledWith(operation, credentials);
  });

  it("validates action-specific request payloads before invoking the executor", async () => {
    const execute = vi.fn().mockResolvedValue({ providerRef: "provider-ref-a" });
    const strictValidator = createStrictProviderRequestPayloadValidator({
      plan: z.string().trim().min(1).max(80)
    });
    const validateRequestPayload = vi.fn(strictValidator);
    const registry = createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload, execute }
    ]);
    const invalidOperation = { ...operation, requestPayload: { unexpected: true } } as ProviderOperation;
    await expect(registry(invalidOperation, credentials)).rejects.toMatchObject({
      name: "ProviderOperationExecutionError",
      status: ProviderOperationStatus.PERMANENT_FAILURE,
      code: "PROVIDER_REQUEST_INVALID"
    });
    expect(validateRequestPayload).toHaveBeenCalledWith(invalidOperation.requestPayload);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed for an unregistered action without invoking an executor", async () => {
    const execute = vi.fn();
    const registry = createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute }
    ]);
    await expect(registry({ ...operation, action: "subscription.delete" }, credentials)).rejects.toMatchObject({
      name: "ProviderOperationExecutionError",
      status: ProviderOperationStatus.PERMANENT_FAILURE,
      code: "PROVIDER_EXECUTOR_UNSUPPORTED"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed when the selected connection has an unregistered provider type", async () => {
    const execute = vi.fn();
    const registry = createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute }
    ]);
    await expect(registry(operation, { ...credentials, providerType: "OTHER" })).rejects.toMatchObject({
      name: "ProviderOperationExecutionError",
      status: ProviderOperationStatus.PERMANENT_FAILURE,
      code: "PROVIDER_EXECUTOR_UNSUPPORTED"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an empty registry", () => {
    expect(() => createProviderOperationExecutorRegistry([])).toThrow("At least one provider-operation executor must be registered.");
  });

  it.each(["", " ", " TEST", "TEST "])("rejects non-canonical provider type %j", (providerType) => {
    expect(() => createProviderOperationExecutorRegistry([
      { providerType, action: "subscription.create", validateRequestPayload: vi.fn(), execute: vi.fn() }
    ])).toThrow(/provider type must be a non-empty canonical string/);
  });

  it.each(["", " ", " subscription.create", "subscription.create "])("rejects non-canonical action registration %j", (action) => {
    expect(() => createProviderOperationExecutorRegistry([
      { providerType: "TEST", action, validateRequestPayload: vi.fn(), execute: vi.fn() }
    ])).toThrow(/action must be a non-empty canonical string/);
  });

  it("rejects duplicate provider type and action registrations instead of overwriting", () => {
    expect(() => createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute: vi.fn() },
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute: vi.fn() }
    ])).toThrow('Provider-operation executor for "TEST" action "subscription.create" is already registered.');
  });

  it("allows the same action to be registered for different provider types", () => {
    const testExecutor = vi.fn().mockResolvedValue({ providerRef: "test-ref" });
    const otherExecutor = vi.fn().mockResolvedValue({ providerRef: "other-ref" });
    const registry = createProviderOperationExecutorRegistry([
      { providerType: "TEST", action: "subscription.create", validateRequestPayload: vi.fn(), execute: testExecutor },
      { providerType: "OTHER", action: "subscription.create", validateRequestPayload: vi.fn(), execute: otherExecutor }
    ]);
    return expect(registry(operation, credentials)).resolves.toEqual({ providerRef: "test-ref" });
  });
});
