# Architecture Overview

## Source of truth

The product specification defines the platform requirements. Channel handlers are adapters; business rules belong in domain and application services.

## Architectural layers

- **Channels:** Telegram bot webhooks, Telegram Mini App, web storefront, tenant admin, platform admin, and REST APIs.
- **Application services:** authorization-aware use cases, orchestration, validation, idempotency, and transaction boundaries.
- **Business domains:** identity, tenancy, catalog, commerce, payments, wallet, subscriptions, provisioning, CRM, support, marketing, resellers, partners, accounting, reporting, migration, notifications, and platform administration.
- **Infrastructure adapters:** Prisma/PostgreSQL, Upstash Redis, QStash, Telegram Bot API, storage, payment providers, and VPN/supplier providers.

## Persistence rules

PostgreSQL is authoritative for business and financial state. Redis is a cache/session/rate-limit layer and is not financial truth. Money uses integer minor units (BigInt in the initial schema). Provider operations and jobs must be durable and idempotent before external side effects.

## Tenant isolation

Tenant-scoped database access must use the tenant client and domain authorization checks. The Prisma query extension scopes supported top-level operations on an allowlist of tenant-bearing models and rejects nested relation writes for create, update, and upsert. It does **not** validate whether scalar foreign-key references (such as `orderId`, `customerId`, `productId`, or `planId`) belong to the same tenant, and it is not a complete isolation boundary. Domain services must verify ownership and permissions; database-enforced tenant-consistent composite foreign keys and PostgreSQL row-level security remain important follow-up work. Cross-tenant integration tests against PostgreSQL are still required. Do not expose the unscoped client to request handlers. Global platform operations must use it only from platform-authorized services.

## Serverless constraints

No process memory or local disk may be treated as durable production state. The Redis memory fallback exists only for local development and is not shared between serverless instances. Long-running work must be persisted and processed in bounded, retryable units.

## Current implementation status

The foundation currently includes the initial Prisma schema, cache adapter, tenant query extension, password-based authentication and persistent sessions, catalog reads, and customer order creation/read endpoints. GitHub Actions validates the Prisma schema, generates the Prisma client, typechecks, lints, runs unit tests, and builds the production application. These checks establish that the code validates and builds; they do not establish production readiness or end-to-end correctness against a live PostgreSQL/Redis deployment.
