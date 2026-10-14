# Provider Adapter Contract

## Status

This document defines the integration boundary for provider adapters. It does not implement a vendor API, enable job dispatch, or authorize production traffic.

## Existing execution contract

The provider-operation handler invokes an injected executor with the persisted `ProviderOperation`. The executor returns a JSON-compatible response payload or throws `ProviderOperationExecutionError`. The operation is tenant-scoped and is claimed before the external action is called.

Persisted `action` names are routed by the explicit executor registry. An action that is not registered fails closed. Do not map arbitrary user input directly to a provider method.

## Required adapter behavior

Every concrete adapter must:

1. **Validate the action input.** Parse and validate `requestPayload` against an action-specific schema before making a network request. Reject unknown fields when they could alter provider behavior.
2. **Use the operation idempotency key.** Pass `operation.idempotencyKey` to the provider's idempotency mechanism when supported. If the provider has no idempotency support, document the duplicate-side-effect risk and provide a provider-specific reconciliation strategy before enabling the action.
3. **Scope credentials to the tenant connection.** Resolve credentials from a tenant-owned provider connection using server-side authorization. Never accept provider credentials from an order payload, browser, or Telegram message.
4. **Apply bounded network controls.** Use explicit connection and total timeouts, bounded response sizes, and a bounded retry policy for safe read-only lookups. Do not blindly retry side-effecting requests after a timeout or connection loss.
5. **Classify outcomes conservatively.** Use `RETRYABLE_FAILURE` only when there is reliable evidence that the action was not applied and a repeat is safe. Use `PERMANENT_FAILURE` for confirmed non-retryable rejection. Treat timeouts, dropped connections after submission, malformed success responses, and ambiguous server errors as `UNKNOWN` unless provider documentation gives a reliable way to determine the outcome.
6. **Return a minimal JSON response.** Store only identifiers and fields required for fulfillment and reconciliation. Do not return access tokens, passwords, private keys, full provider credentials, or unnecessary personal data.
7. **Sanitize errors.** Error codes should be stable, non-secret identifiers. Error messages persisted by the current service are bounded in length but are not automatically scrubbed of secrets; adapters must not include credentials, authorization headers, or sensitive request/response bodies in thrown messages.
8. **Support reconciliation.** Define how an operator or maintenance task checks provider state by a stable provider reference or idempotency key and resolves an `UNKNOWN` operation. Reconciliation must not issue a second create/provision request merely to discover the result.
9. **Be explicit about capabilities.** Document provider idempotency semantics, consistency delays, rate limits, supported actions, credential requirements, and whether each error response proves that no side effect occurred.

## Error mapping

| Evidence | Operation outcome |
| --- | --- |
| Provider confirms action succeeded and returns a valid response | Return a minimal JSON payload |
| Provider confirms no action was applied and retry is safe | Throw `ProviderOperationExecutionError(RETRYABLE_FAILURE, ...)` |
| Provider definitively rejects the action and repeating it cannot help | Throw `ProviderOperationExecutionError(PERMANENT_FAILURE, ...)` |
| Request outcome is ambiguous or success cannot be durably recorded | Treat as `UNKNOWN`; reconcile before repeating |

Do not classify errors solely by HTTP status code without considering the provider's documented semantics and whether the request may already have taken effect.

## Runtime wiring and readiness gate

Before registering a production adapter or exposing a dispatch endpoint:

- Verify required environment configuration at startup and fail readiness if required values are missing.
- Confirm provider credentials are loaded from the correct tenant-owned connection and are decrypted only on the server.
- Register only explicitly supported action names.
- Ensure the worker's concurrency and rate limits respect provider quotas.
- Ensure request signing/authentication, replay protection, and internal dispatch authorization are in place.
- Verify logs and traces redact credentials and sensitive payloads.
- Add adapter tests for success, duplicate delivery, definitive rejection, safe retry, ambiguous timeout, malformed responses, and cross-tenant credential isolation.
- Run schema validation, typecheck, lint, tests, and production build in CI before deployment.
- Test reconciliation and recovery against a provider sandbox before enabling real side effects.

The current repository provides execution primitives and registries, not these vendor-specific guarantees. Do not enable real provider calls until a concrete adapter satisfies this contract.
