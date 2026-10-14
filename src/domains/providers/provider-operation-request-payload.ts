import type { Prisma } from "@prisma/client";

const MAX_SERIALIZED_LENGTH = 16_384;
const MAX_DEPTH = 8;
const MAX_NODES = 512;
const MAX_STRING_LENGTH = 4_096;
const MAX_OBJECT_KEYS = 100;
const MAX_ARRAY_LENGTH = 100;
const MAX_KEY_LENGTH = 128;

type NormalizedJsonValue = string | number | boolean | null | NormalizedJsonValue[] | { [key: string]: NormalizedJsonValue };

export function validateProviderOperationRequestPayload(value: unknown): Prisma.InputJsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider request payload must be a plain object.");
  }

  let nodeCount = 0;
  const ancestors = new Set<object>();

  function normalize(current: unknown, depth: number): NormalizedJsonValue {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new Error("Provider request payload exceeds the complexity limit.");
    if (depth > MAX_DEPTH) throw new Error("Provider request payload exceeds the nesting limit.");

    if (current === null || typeof current === "string" || typeof current === "boolean") {
      if (typeof current === "string" && current.length > MAX_STRING_LENGTH) {
        throw new Error("Provider request payload contains an oversized string.");
      }
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Provider request payload contains an invalid number.");
      return current;
    }
    if (typeof current !== "object") throw new Error("Provider request payload contains a non-JSON value.");
    if (ancestors.has(current)) throw new Error("Provider request payload must not contain circular references.");

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_ARRAY_LENGTH) throw new Error("Provider request payload contains an oversized array.");
        const keys = Reflect.ownKeys(current);
        if (keys.length !== current.length + 1 || keys.some((key) =>
          typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
        )) {
          throw new Error("Provider request payload arrays must not contain holes or extra properties.");
        }
        const normalized: NormalizedJsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("Provider request payload arrays must contain only data elements.");
          }
          normalized.push(normalize(descriptor.value, depth + 1));
        }
        return normalized;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Provider request payload must contain only plain objects.");
      }

      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string")) {
        throw new Error("Provider request payload must not contain symbol keys.");
      }
      if (keys.length > MAX_OBJECT_KEYS) throw new Error("Provider request payload contains too many object fields.");

      const normalized: Record<string, NormalizedJsonValue> = Object.create(null) as Record<string, NormalizedJsonValue>;
      for (const key of keys as string[]) {
        if (!key || key.length > MAX_KEY_LENGTH) {
          throw new Error("Provider request payload contains an invalid field name.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("Provider request payload must contain only enumerable data fields.");
        }
        normalized[key] = normalize(descriptor.value, depth + 1);
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }

  const normalized = normalize(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw new Error("Provider request payload is not valid JSON.");
  }
  if (serialized.length > MAX_SERIALIZED_LENGTH) {
    throw new Error("Provider request payload exceeds the size limit.");
  }
  return normalized as Prisma.InputJsonValue;
}
