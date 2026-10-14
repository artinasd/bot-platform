import type { Prisma } from "@prisma/client";

/**
 * Persist only the normalized identifiers needed for fulfillment/reconciliation.
 * Vendor response bodies must be parsed into this shape by the adapter first.
 */
const ALLOWED_FIELDS = new Set(["providerRef", "resourceId", "requestId", "status"]);
const MAX_FIELD_LENGTH = 256;
const MAX_SERIALIZED_LENGTH = 2048;

export function validateProviderOperationResponsePayload(value: unknown): Prisma.InputJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider response payload must be a plain object.");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Provider response payload must be a plain object.");
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, fieldValue] of Object.entries(record)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error("Provider response payload contains an unsupported field.");
    }
    if (
      typeof fieldValue !== "string" ||
      !fieldValue.trim() ||
      fieldValue.length > MAX_FIELD_LENGTH ||
      fieldValue.trim() !== fieldValue ||
      /[\u0000-\u001f\u007f]/.test(fieldValue)
    ) {
      throw new Error("Provider response payload contains an invalid field value.");
    }
    normalized[key] = fieldValue;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw new Error("Provider response payload is not valid JSON.");
  }
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new Error("Provider response payload exceeds the size limit.");
  }

  return normalized as Prisma.InputJsonValue;
}
