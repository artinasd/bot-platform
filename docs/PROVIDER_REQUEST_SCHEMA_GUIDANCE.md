# Provider Request Schema Guidance

## Validation is not normalization

The shared `createStrictProviderRequestPayloadValidator` helper is a validation gate, not a parser that returns a replacement payload. It calls Zod's `safeParse` and throws a generic error on failure, but its parsed result is intentionally discarded. The executor therefore receives the original persisted JSON value after validation.

For that reason, action schemas must be **validation-only**: do not use transforms such as `.trim()`, coercion such as `z.coerce.number()`, defaults, preprocessors, or other schema behavior that accepts one representation but expects the executor to receive a different representation. Validate the actual persisted type and shape instead.

For example:

```ts
const validateCreateSubscription = createStrictProviderRequestPayloadValidator({
  plan: z.string().min(1).max(80).refine((value) => value.trim().length > 0),
  seats: z.number().int().min(1).max(100)
});
```

The refinement rejects whitespace-only plan names without silently trimming the persisted value; the integer validator rejects numeric strings instead of coercing them. The validator checks the input but does not return a normalized object.

If an action needs normalization, implement it explicitly in a separately reviewed boundary that returns a typed normalized payload and ensure the executor uses that returned value. Do not assume validation has transformed the operation payload.

See also [the provider adapter contract](./PROVIDER_ADAPTER_CONTRACT.md), which requires each action to validate its payload before making a vendor request.
