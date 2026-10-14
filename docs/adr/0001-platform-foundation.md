# ADR 0001: Platform Foundation

- **Status:** Accepted
- **Date:** 2026-10-14

## Problem

The repository is empty, while the product specification calls for a multi-tenant commerce platform with independent business domains and multiple communication channels.

## Options

1. Implement a single Telegram bot with commerce logic embedded in handlers.
2. Implement domain services first and treat Telegram, web, Mini App, and APIs as adapters.
3. Reuse an external bot implementation as the core.

## Decision

Choose option 2. The specification is the source of truth, and the repository will be initialized around domain boundaries, relational persistence, explicit tenant isolation, and provider adapters.

## Rationale

This keeps business rules independent from channels and infrastructure providers, supports future channels, and reduces the risk of importing unrelated assumptions from external projects.

## Consequences

The initial implementation requires more explicit interfaces and tests. Features are not complete merely because a database model or UI exists. External integrations must be represented by adapters and tested with deterministic mocks before live credentials are configured.
