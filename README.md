# Bot Platform

A multi-tenant platform foundation for VPN subscriptions and digital products, designed around domain services with Telegram, web storefront, Telegram Mini App, and API channels as adapters.

## Current status

This repository is an early foundation, not a complete or production-ready product. Database models and a few infrastructure/domain primitives exist; Authentication/session primitives, catalog and order services, and authorization primitives have initial implementations; end-to-end authorization coverage, tenant onboarding, storefront, Telegram processing, provider adapters, payment integrations, reporting, migration flows, and production deployment hardening remain incomplete.

## Stack

- Next.js App Router
- TypeScript
- PostgreSQL through Prisma
- Upstash Redis for shared cache/session/rate-limit primitives
- Vitest for unit tests

## Local setup

Requirements: Node.js 20.9+ and npm.

1. Install dependencies with npm install.
2. Copy .env.example to .env.
3. Configure DATABASE_URL and DIRECT_URL for a PostgreSQL database.
4. Generate Prisma client: npm run prisma:generate.
5. Validate schema: npm run prisma:validate.
6. Run the development server: npm run dev.

Useful checks:

- npm run typecheck
- npm run lint
- npm test
- npm run build

Do not run db:push or migrations against production without reviewing the generated schema changes and taking a backup.

## Environment variables

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | PostgreSQL pooled/runtime connection URL |
| DIRECT_URL | Direct PostgreSQL connection URL for Prisma schema operations |
| UPSTASH_REDIS_REST_URL | Upstash Redis REST endpoint |
| UPSTASH_REDIS_REST_TOKEN | Upstash Redis token |
| APP_URL | Application base URL |
| APP_REGION | Preferred deployment region |
| AUTH_SECRET | Reserved for future signed artifacts; opaque sessions currently use random tokens stored as hashes in PostgreSQL |
| SESSION_COOKIE_NAME | Session cookie name used by login, logout, and current-session endpoints |
| SESSION_TTL_SECONDS | Session lifetime in seconds (60 seconds to 30 days) |
| CREDENTIAL_ENCRYPTION_KEY | Base64-encoded 32-byte AES-256-GCM key for provider credentials |
| INTERNAL_JOB_SECRET | Internal job-dispatch authentication secret; dispatch endpoint is not yet implemented |
| QSTASH_TOKEN | QStash token for future asynchronous dispatch |
| QSTASH_CURRENT_SIGNING_KEY | Current QStash signature verification key |
| QSTASH_NEXT_SIGNING_KEY | Next QStash signature verification key |
| SUPABASE_URL | Supabase project URL for the future storage adapter |
| SUPABASE_SERVICE_ROLE_KEY | Server-only Supabase service-role key |
| SUPABASE_STORAGE_BUCKET | Supabase Storage bucket name |
| TELEGRAM_PLATFORM_BOT_TOKEN | Optional platform-owned Telegram bot token |
| TELEGRAM_WEBHOOK_BASE_URL | Base URL for Telegram webhook configuration |
| PLATFORM_BOOTSTRAP_EMAIL | Optional platform bootstrap identity email |
| PLATFORM_BOOTSTRAP_PASSWORD | Optional bootstrap password; never set a default or commit a real value |
| LOG_LEVEL | Application log verbosity |

Never commit real credentials. Rotate any credential accidentally committed to repository history.

## Durable job worker

The queue can lease one due job at a time through `JobQueue.claimNext`. `JobWorker` dispatches only explicitly registered job types and reports success or failure only while the worker still owns a live lease. Handlers may throw `RetryableJobError` only when they know retrying is safe; retry delays use bounded exponential backoff. Unclassified exceptions are treated as uncertain outcomes and are not automatically retried, because an external side effect may already have happened. Unknown job types fail closed. This is an execution primitive, not a deployed scheduler or a provider integration; no external jobs are run by this change.

## Provider-operation job handler

`createProviderOperationJobHandler` accepts jobs whose payload contains an `operationId` and whose `tenantId` is set. It claims the tenant-scoped operation before calling an injected provider executor and records the response on success. Duplicate delivery of an already successful operation is a no-op; an `UNKNOWN` operation is blocked until explicit reconciliation. Unclassified executor errors become `UNKNOWN`. Provider adapters may throw `ProviderOperationExecutionError` with `RETRYABLE_FAILURE` only when they can establish that retrying is safe, and should use the durable operation idempotency key with providers that support it. This bridge does not implement a provider API, scheduler, or dispatch endpoint.

## Architecture guardrails

- PostgreSQL is the source of truth for orders, payments, wallets, subscriptions, and tenant data.
- Redis is not durable business storage; the in-memory fallback is only for local development and is not shared across serverless instances.
- Store monetary values as integer minor units. Avoid floating-point currency calculations.
- External provider calls must use durable, idempotent operations with bounded retries.
- Never mark an order paid based on a browser redirect or unverified client assertion.
- Tenant ownership and role/capability checks must be enforced in application services, not inferred from user-controlled request fields.
- Keep secrets encrypted at rest and never return credentials in API responses or logs.
- Cross-tenant access tests are still required before treating the current isolation helpers as production-grade.

## Tenant database access

createTenantClient is intended as a defense-in-depth query scoping helper. It is not a complete authorization system and must not be the sole security boundary. Global platform operations should use the unscoped client only within explicitly authorized platform services. Review and test Prisma operation coverage before relying on this extension for production isolation.

## CI

GitHub Actions runs Prisma validation/generation, TypeScript checks, ESLint, unit tests, and a production build. A green workflow is required before treating a commit as verified.


## Internal job-dispatch authentication

`isValidInternalJobAuthorization` validates an exact `Bearer` authorization header against `INTERNAL_JOB_SECRET`, requires a configured secret of at least 32 characters, and compares fixed-size SHA-256 digests with a constant-time comparison. The helper fails closed when configuration is missing or weak. It is only an authentication primitive; there is not yet an HTTP dispatch endpoint or registered production handler set.

## Provider-operation recovery sweep

`ProviderOperationRecoveryService` provides a bounded maintenance sweep for stale provider operations. It scans at most 500 tenants per call by default, considers only operations still marked `RUNNING` for at least five minutes, and transitions those operations to `UNKNOWN` through the tenant-scoped provider-operation service. It deliberately does not retry the provider action or decide whether it succeeded. Run it from a trusted scheduler/maintenance worker, then reconcile each unknown outcome against the provider before any retry. The sweep is not wired to an HTTP endpoint or automatically scheduled.


## Explicit job-handler registry

`createJobHandlerRegistry` constructs a frozen registry from explicit `{ type, handler }` registrations. It rejects empty registries, blank/non-canonical types, non-callable handlers, and duplicate job types instead of silently overwriting a registration. The registry uses a null prototype, so inherited object properties cannot masquerade as handlers. This is a registration primitive only: it does not activate a scheduler, expose an HTTP endpoint, or claim queued work. A dispatch endpoint should not be enabled until real handlers and their dependencies are explicitly wired and readiness is checked before any job is claimed.


## Provider-operation scheduling

`ProviderOperationSchedulingService` creates or retrieves an idempotent tenant-scoped provider operation and ensures a durable `provider.operation.execute` job is present. The job payload contains only the operation ID; tenant ownership comes from the persisted operation and is checked again by the handler. Successful, unknown, and permanently failed operations are not scheduled for blind execution. The job uses the operation ID as a stable correlation ID so repeated requests cannot conflict because of caller-specific tracing IDs. The operation and job writes are not atomic; if enqueueing fails, repeating the same idempotent request can complete scheduling. Existing FAILED or CANCELLED jobs are reported as requiring explicit requeue rather than being misreported as scheduled, and an inconsistent succeeded job is rejected for reconciliation. This service does not supply a provider adapter or run jobs by itself.


## Provider-operation executor registry and explicit retry

`createProviderOperationExecutorRegistry` routes exact persisted action names to explicitly registered executor functions and rejects duplicate or non-canonical registrations. Unsupported actions fail closed as permanent failures; this registry does not implement a vendor API.

`ProviderOperationRetryService` is an explicit recovery path for operations already classified as `RETRYABLE_FAILURE`. It refuses `UNKNOWN`, permanently failed, successful, or currently active operations; checks a bounded operation-attempt budget; and transactionally returns an eligible operation to `PENDING` while creating its next job. A retry job receives a generation-specific idempotency key derived from the operation attempt count. Repeating a request after a successful commit returns the same active retry generation instead of creating a second job; terminal or inconsistent retry generations require reconciliation. If the database transaction fails, neither state change is committed. This is a domain primitive, not an HTTP endpoint or automatic retry scheduler. Provider-specific error classification and reconciliation remain mandatory before retrying side effects.
