import type { JobHandler, JobHandlerRegistry } from "./job-worker";

export type JobHandlerRegistration = Readonly<{
  type: string;
  handler: JobHandler;
}>;

/**
 * Builds an immutable registry from explicit registrations.
 *
 * An array is used instead of a plain object so duplicate types can be
 * detected before they silently overwrite a handler. The null prototype also
 * prevents inherited object properties from being treated as registrations.
 */
export function createJobHandlerRegistry(
  registrations: readonly JobHandlerRegistration[]
): JobHandlerRegistry {
  if (registrations.length === 0) {
    throw new Error("At least one job handler must be registered.");
  }

  const registry = Object.create(null) as Record<string, JobHandler>;

  for (const registration of registrations) {
    if (
      typeof registration.type !== "string" ||
      registration.type.trim().length === 0 ||
      registration.type.trim() !== registration.type
    ) {
      throw new Error("Job handler type must be a non-empty canonical string.");
    }

    if (typeof registration.handler !== "function") {
      throw new Error(`Job handler for "${registration.type}" must be a function.`);
    }

    if (Object.hasOwn(registry, registration.type)) {
      throw new Error(`Job handler type "${registration.type}" is already registered.`);
    }

    registry[registration.type] = registration.handler;
  }

  return Object.freeze(registry);
}
