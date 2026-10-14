import { ProviderOperationStatus, type ProviderOperation } from "@prisma/client";
import type { ActiveProviderCredentials } from "./provider-connection-credentials.service";
import type { ProviderOperationExecutor } from "./provider-operation-job-handler";
import { ProviderOperationExecutionError } from "./provider-operation-job-handler";

export type ProviderOperationExecutorRegistration = Readonly<{
  providerType: string;
  action: string;
  validateRequestPayload: (payload: unknown) => void;
  execute: ProviderOperationExecutor;
}>;

function executorKey(providerType: string, action: string): string {
  return JSON.stringify([providerType, action]);
}

/**
 * Routes by both the resolved connection's provider type and the persisted
 * action. Unknown provider/action pairs fail closed before an adapter runs.
 */
export function createProviderOperationExecutorRegistry(
  registrations: readonly ProviderOperationExecutorRegistration[]
): ProviderOperationExecutor {
  if (registrations.length === 0) {
    throw new Error("At least one provider-operation executor must be registered.");
  }

  const executors = new Map<string, ProviderOperationExecutorRegistration>();
  for (const registration of registrations) {
    if (typeof registration.providerType !== "string" || registration.providerType.trim().length === 0 || registration.providerType.trim() !== registration.providerType) {
      throw new Error("Provider-operation provider type must be a non-empty canonical string.");
    }
    if (typeof registration.action !== "string" || registration.action.trim().length === 0 || registration.action.trim() !== registration.action) {
      throw new Error("Provider-operation action must be a non-empty canonical string.");
    }
    if (typeof registration.validateRequestPayload !== "function") {
      throw new Error(`Request validator for "${registration.providerType}" action "${registration.action}" must be a function.`);
    }
    if (typeof registration.execute !== "function") {
      throw new Error(`Executor for "${registration.providerType}" action "${registration.action}" must be a function.`);
    }
    const key = executorKey(registration.providerType, registration.action);
    if (executors.has(key)) {
      throw new Error(`Provider-operation executor for "${registration.providerType}" action "${registration.action}" is already registered.`);
    }
    executors.set(key, registration);
  }

  return async (operation: ProviderOperation, credentials: ActiveProviderCredentials) => {
    const registration = executors.get(executorKey(credentials.providerType, operation.action));
    if (!registration) {
      throw new ProviderOperationExecutionError(
        ProviderOperationStatus.PERMANENT_FAILURE,
        "PROVIDER_EXECUTOR_UNSUPPORTED",
        "No provider executor is registered for this connection type and action."
      );
    }
    try {
      registration.validateRequestPayload(operation.requestPayload);
    } catch {
      throw new ProviderOperationExecutionError(
        ProviderOperationStatus.PERMANENT_FAILURE,
        "PROVIDER_REQUEST_INVALID",
        "Provider operation request payload failed action-specific validation."
      );
    }
    return registration.execute(operation, credentials);
  };
}
