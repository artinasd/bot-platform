# Provider Adapter Contract

## Status

This document defines the integration boundary for provider adapters. It does not implement a vendor API, enable job dispatch, or authorize production traffic.

## Existing execution contract

The provider-operation handler claims the tenant-scoped operation, then resolves `providerConnectionId` through `ProviderConnectionCredentialsService` using the job tenant immediately before invoking an injected executor. The executor receives the persisted `ProviderOperation` and the resolved active connection credentials as separate server-side arguments. The executor returns a JSON-compatible response payload or throws `ProviderOperationExecutionError`. If the connection ID is absent, inactive, revoked, cross-tenant, or cannot be decrypted, the handler records a permanent pre-execution failure and never calls the executor; raw resolver errors are not persisted.

Executors are registered by the exact pair of resolved connection `providerType` and persisted operation `action`. Every registration must supply both an action-specific `validateRequestPayload` function and an executor. The registry runs that validator against the persisted request payload before calling the executor; a validation failure becomes a generic permanent `PROVIDER_REQUEST_INVALID` failure and the executor is not invoked. Validators must reject unsupported fields and invalid action-specific values without logging or exposing payload contents. This runtime gate complements (but does not replace) adapter-side validation at the vendor boundary. This prevents an action registered for one vendor from accidentally receiving another vendor's credentials. Unsupported provider/action pairs fail closed. Do not map arbitrary user input directly to a provider method.

## Required adapter behavior

Every concrete adapter must:

1. **Validate the action input.** Parse and validate `requestPayload` against an action-specific schema before making a network request. Reject unknown fields when they could alter provider behavior.
2. **Use the operation idempotency key.** Pass `operation.idempotencyKey` to the provider's idempotency mechanism when supported. If the provider has no idempotency support, document the duplicate-side-effect risk and provide a provider-specific reconciliation strategy before enabling the action.
3. **Use only the resolved tenant connection credentials.** Consume credentials supplied by the server-side execution boundary. Never accept provider credentials from an order payload, browser, or Telegram message.
4. **Apply bounded network controls.** Use explicit connection and total timeouts, bounded response sizes, and a bounded retry policy for safe read-only lookups. Do not blindly retry side-effecting requests after a timeout or connection loss.
5. **Classify outcomes conservatively.** Use `RETRYABLE_FAILURE` only when there is reliable evidence that the action was not applied and a repeat is safe. Use `PERMANENT_FAILURE` for confirmed non-retryable rejection. Treat timeouts, dropped connections after submission, malformed success responses, and ambiguous server errors as `UNKNOWN` unless provider documentation gives a reliable way to determine the outcome.
6. **Return a normalized response payload.** Before returning from an executor, map the vendor response into the persisted allowlist: optional string fields `providerRef`, `resourceId`, `requestId`, and `status` only. Each value must be non-empty and at most 256 characters; the serialized object is capped at 2 KiB. Unknown keys, nested objects/arrays, non-string values, and raw vendor bodies are rejected at the service persistence boundary for both normal success and reconciled success. Extend this contract deliberately when a real action proves it needs another field; do not widen it to arbitrary `metadata`. Never return access tokens, passwords, private keys, full provider credentials, or unnecessary personal data.
7. **Sanitize errors.** The handler and provider-operation service persistence methods store status-specific generic messages rather than caller-supplied exception or reconciliation text; this remains true when those service methods are called directly. It accepts an adapter error code only when it matches the stable uppercase identifier format `[A-Z0-9_]{1,80}`; otherwise it records `PROVIDER_OPERATION_FAILED`. Adapters should still use stable non-secret codes and must never include credentials, authorization headers, or sensitive request/response bodies in thrown messages. Detailed diagnostics belong in separately controlled, redacted observability—not operation records or job errors.
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

## Provider connection routing status

`ProviderOperation` now persists a required `providerConnectionId` with a composite relation to `ProviderConnection` on `[tenantId, id]`. The operation-creation service checks that the selected connection is active and belongs to the same tenant. The connection ID is part of idempotency comparison, so reusing a key to switch provider accounts is rejected. PostgreSQL constraint verification also covers cross-tenant connection references.

The current CI workflow generates an initial migration baseline from an empty schema for review; it is **not** an upgrade migration for an existing database. This repository has no checked-in migration history. Do not apply the generated baseline to an existing environment or deploy the required column to a populated database without a separately reviewed rollout plan. That plan must inventory existing provider operations, choose and validate their intended connections, backfill the association, then enforce the non-null and composite foreign-key constraints. Never guess a connection or backfill by selecting the first active connection.

The credential resolver is now wired into the provider-operation job handler. Every execution rechecks the exact connection ID against the job tenant and requires the connection to remain active. Missing IDs and resolver failures are handled before executor invocation, without persisting raw resolver errors. Concrete provider adapters remain unimplemented and real provider calls remain disabled until adapter behavior and the database migration rollout are reviewed.

## Required adapter test matrix

Implement this matrix for each provider/action pair before registering it in a runtime registry. Tests must inject a fake transport or provider client; unit tests must not use production credentials, contact vendor endpoints, or perform real side effects. Keep the adapter's HTTP/client boundary injectable so the tests can assert both classification and whether a request was sent.

| Scenario | Controlled fixture | Required assertions |
| --- | --- | --- |
| Confirmed success | Valid provider success response with a stable reference | Adapter returns only the documented minimal response fields; no credential, authorization header, or full raw response is returned. |
| Duplicate delivery | Invoke the same operation twice with the same idempotency key | Both invocations use the same provider idempotency key where supported; the fake provider records at most one logical side effect. If the vendor lacks idempotency, test the documented deduplication/reconciliation behavior and keep the action disabled until its risk is accepted. |
| Definitive rejection | Provider response documented to prove the action was not applied and the request is not retryable | Adapter classifies it as `PERMANENT_FAILURE`; the handler does not schedule a retry; persisted error text stays generic. |
| Confirmed transient non-application | Provider explicitly confirms no side effect occurred and retry is safe | Adapter classifies it as `RETRYABLE_FAILURE`; retry policy remains bounded; no automatic retry is allowed if the response does not prove non-application. |
| Timeout before sending | Fake transport fails before the request leaves the client | Classify as retryable only if the transport reliably proves no request was sent; assert bounded timeout configuration. |
| Timeout or disconnect after submission | Fake transport accepts the request, then times out before a response | Classify as `UNKNOWN`; do not blindly send a second create/provision request; require reconciliation. |
| Malformed success response | HTTP success with invalid JSON, missing required reference, unexpected shape, or oversized body | Do not mark the operation succeeded; classify as `UNKNOWN` unless provider evidence reliably proves no side effect; enforce response-size and schema limits. |
| Provider 5xx / rate limit | Responses whose side-effect semantics vary by provider | Assert classification against documented vendor semantics, not status code alone. Retry only when non-application is proven; otherwise mark unknown. |
| Reconciliation finds applied action | Lookup by provider reference or idempotency key returns the created resource | Resolve `UNKNOWN` to `SUCCEEDED` with a minimal validated payload; assert reconciliation performs no create/provision call. |
| Reconciliation proves not applied | Authoritative lookup establishes no side effect, accounting for provider consistency delays | Resolve to `RETRYABLE_FAILURE` only after the adapter's documented certainty threshold; the next attempt uses the original idempotency key. |
| Reconciliation remains inconclusive | Lookup unavailable, inconsistent, or returns an ambiguous result | Leave operation `UNKNOWN`; do not permit retry or silently convert the state to success/failure. |
| Tenant credential isolation | Provide credentials resolved for tenant A and an operation/job for tenant B, or a mismatched connection/provider type | Handler fails closed before the adapter transport is called; no credential from another tenant reaches the fake client. |
| Secret and payload redaction | Inject secret-like strings in exceptions, response headers, and malformed bodies | Persisted operation/job errors and adapter return values contain none of the injected secrets; diagnostics, if any, use a separately reviewed redaction path. |

### Test organization and release gate

- Keep pure classification and response-schema tests close to each adapter. Use a fake transport for timeout stages, malformed responses, and request-count assertions.
- Add contract-level tests through the existing executor registry and job handler to verify the registered `providerType` + `action` pair, tenant-scoped credentials, idempotency key propagation, status transitions, and generic persistence messages.
- Test recovery through the explicit `resolveUnknown` path. Never treat expiry of a worker lease as evidence that the provider did not apply the action.
- Use provider sandbox tests only after the unit contract suite passes, with isolated sandbox credentials and disposable test resources. Sandbox tests must be separately enabled and must never run as part of ordinary CI by default.
- Record per-action evidence for idempotency support, timeout semantics, consistency delay, reconciliation lookup, rate limits, and which responses prove non-application. A checklist marked complete without provider documentation or a reproducible test is not sufficient.
- Until these cases pass for a concrete implementation and the existing-database migration rollout is reviewed, keep the adapter unregistered for production dispatch. This matrix is a release gate, not evidence that any vendor integration already exists.



## Persisted provider response payload contract

The service accepts only a plain object containing zero or more of these normalized string fields: `providerRef`, `resourceId`, `requestId`, and `status`. Each field is required to be a non-empty string no longer than 256 characters, and the serialized object must not exceed 2 KiB. Unknown fields are rejected, so a raw HTTP response, nested vendor object, authorization token, or arbitrary metadata cannot be persisted accidentally. Both executor success and `resolveUnknown(SUCCEEDED)` pass through the same validator before any database update. Vendor adapters are responsible for parsing and validating their own action-specific response schema and projecting only the required values into this normalized contract. Adding a field requires a deliberate contract and test change.
