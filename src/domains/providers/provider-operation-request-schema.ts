import { z } from "zod";

/**
 * Build an action-specific validator that rejects unknown root fields.
 * Keep schemas narrow: only include fields the provider action actually needs.
 */
export function createStrictProviderRequestPayloadValidator(
  shape: Record<string, z.ZodType>
): (payload: unknown) => void {
  const schema = z.strictObject(shape);

  return (payload: unknown): void => {
    const result = schema.safeParse(payload);
    if (!result.success) {
      // Do not leak submitted values or schema internals into job error logs.
      throw new Error("Provider request payload does not match the action schema.");
    }
  };
}
