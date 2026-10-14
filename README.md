# Bot Platform

A multi-tenant platform foundation for VPN subscriptions and digital products, designed around domain services with Telegram, web storefront, Telegram Mini App, and API channels as adapters.

## Current status

This repository is an early foundation, not a complete or production-ready product. Database models and a few infrastructure/domain primitives exist; full authentication, authorization, tenant onboarding, storefront, Telegram processing, provider adapters, payment integrations, reporting, migration flows, and production deployment hardening remain incomplete.

## Stack

- Next.js App Router
- TypeScript
- PostgreSQL through Prisma
- Upstash Redis for shared cache/session/rate-limit primitives
- Vitest for unit tests

## Local setup

Requirements: Node.js 20.9+ and npm.

1. Install dependencies with npm ci.
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
| UPSTASH_REDIS_REST_TOKEN | Upstash Redis REST token |
| APP_BASE_URL | Canonical application base URL |
| APP_ENCRYPTION_KEY | Key material for a future secrets-encryption adapter; not yet consumed by application code |
| CRON_SECRET | Secret for future authenticated scheduled-task endpoints; not yet consumed by application code |

Never commit real credentials. Rotate any credential accidentally committed to repository history.

## Architecture guardrails

- PostgreSQL is the source of truth for orders, payments, wallets, subscriptions, and tenant data.
- Redis is not durable business storage; the in-memory fallback is only for local development and is not shared across serverless instances.
- Store monetary values as integer minor units. Avoid floating-point currency calculations.
- External provider calls must use durable, idempotent operations with bounded retries.
- Never mark an order paid based on a browser redirect or unverified client assertion.
- Tenant ownership and role/capability checks must be enforced in application services, not inferred from user-controlled request fields.
- Keep secrets encrypted at rest and never return credentials in API responses or logs.
- Add cross-tenant access tests before exposing tenant-owned resources through HTTP or Telegram.

## Tenant database access

createTenantClient is intended as a defense-in-depth query scoping helper. It is not a complete authorization system and must not be the sole security boundary. Global platform operations should use the unscoped client only within explicitly authorized platform services. Review and test Prisma operation coverage before relying on this extension for production isolation.

## CI

GitHub Actions runs Prisma validation/generation, TypeScript checks, ESLint, unit tests, and a production build. A green workflow is required before treating a commit as verified.
