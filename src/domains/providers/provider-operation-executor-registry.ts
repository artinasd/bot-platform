import { ProviderOperationStatus, type ProviderOperation } from "@prisma/client";
import type { ActiveProviderCredentials } from "./provider-connection-credentials.service";
import type { ProviderOperationExecutor } from "./provider-operation-job-handler";
import { ProviderOperationExecutionError } from "./provider-operation-job-handler";

export type ProviderOperationExecutorRegistration = Readonly<{
  action: string;
  execute: ProviderOperationExecutor;
}>;

/**
 * Routes persisted provider actions to explicitly registered executors.
 * Unknown actions fail closed before any adapter is invoked.
 */
export function createProviderOperationExecutorRegistry(
  registrations: readonly ProviderOperationExecutorRegistration[]
): ProviderOperationExecutor {
  if (registrations.length === 0) {
    throw new Error("At least one provider-operation executor must be registered.");
  }

  const executors = new Map<string, ProviderOperationExecutor>();
  for (const registration of registrations) {
    if (typeof registration.action !== "string" || registration.action.trim().length === 0 || registration.action.trim() !== registration.action) {
      throw new Error("Provider-operation action must be a non-empty canonical string.");
    }
    if (typeof registration.execute !== "function") {
      throw new Error(`Executor for "${registration.action}" must be a function.`);
    }
    if (executors.has(registration.action)) {
      throw new Error(`Provider-operation action "${registration.action}" is already registered.`);
    }
    executors.set(registration.action, registration.execute);
  }

  return async (operation: ProviderOperation, credentials: ActiveProviderCredentials) => {
    const executor = executors.get(operation.action);
    if (!executor) {
      throw new ProviderOperationExecutionError(
        ProviderOperationStatus.PERMANENT_FAILURE,
        "PROVIDER_ACTION_UNSUPPORTED",
        `No provider executor is registered for action "${operation.action}".`
      );
    }
    return executor(operation, credentials);
  };
}
