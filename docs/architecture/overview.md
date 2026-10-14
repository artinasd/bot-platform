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

Tenant-scoped database access must use the tenant client and domain authorization checks. The tenant client is defense in depth, not a substitute for service-level ownership checks, explicit permissions, and automated cross-tenant tests. Global platform operations must use the unscoped client only from platform-authorized services.

## Serverless constraints

No process memory or local disk may be treated as durable production state. The Redis memory fallback exists only for local development and is not shared between serverless instances. Long-running work must be persisted and processed in bounded, retryable units.

## Current implementation status

This repository is being bootstrapped. The initial schema and infrastructure adapters are not yet verified by running Prisma validation, TypeScript, tests, or a production build. Do not treat the product as production-ready until the feature registry, security tests, domain services, integrations, and deployment checks are complete.
