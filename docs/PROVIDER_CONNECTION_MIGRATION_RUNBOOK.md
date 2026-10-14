# Provider connection association migration runbook

## Status and safety boundary

This is a planning and review document, not an executable migration. The Prisma schema currently requires every `ProviderOperation` to reference a `ProviderConnection` in the same tenant through `[tenantId, providerConnectionId]`. The CI workflow's generated initial baseline starts from an empty database; it must not be applied as an upgrade to a populated environment.

No production database has been inspected or modified as part of this runbook. Do not run `prisma db push`, apply the generated baseline, or add a guessed connection association to an existing database.

## Required decisions before implementation

A migration owner must establish, from the target environment and a reviewed snapshot:

- The exact deployed schema and migration history, including whether `ProviderOperation` already exists and which columns are present.
- Counts of provider operations grouped by status, tenant, order, item, and any existing provider/action/account identifiers.
- Whether any operations are `RUNNING` or `UNKNOWN`; these require reconciliation before changing execution or retry behavior.
- For each historical operation, authoritative evidence of the intended provider account. Valid evidence may be a stored connection/account identifier that can be mapped unambiguously, or reviewed business records with documented provenance. Current activity or a matching provider type alone is not sufficient evidence.
- The backup, restore test, maintenance window, lock/latency budget, rollback owner, and acceptable write pause.
- The approved strategy for records whose intended connection cannot be proven. They must be quarantined/blocked for manual resolution, not assigned an arbitrary active connection.

## Staged rollout

### 0. Establish a recoverable baseline

1. Take a database backup and prove that it can be restored to an isolated environment.
2. Capture the current schema, migration history, row counts, and status counts for provider operations and connections.
3. Run read-only integrity reports for missing tenants/orders/items, inactive connections, and cross-tenant references.
4. Export a protected, access-controlled mapping report for every legacy operation. Do not include credential ciphertext or decrypted secrets in the report.
5. Review the report with the business owner who can identify the intended provider account. Keep unresolved rows explicitly unresolved.

**Gate:** do not proceed until backup/restore, inventory, and account mapping are reviewed and signed off.

### 1. Expand schema without changing dispatch behavior

1. Create a database-specific upgrade migration based on the actual deployed schema; do not use the empty-database baseline as an upgrade.
2. Add `providerConnectionId` as nullable initially if the deployed schema requires a backfill. Add the supporting index/constraint in the order supported by the database and the planned lock budget.
3. Keep provider dispatch disabled or paused while rows can be unassociated. A nullable transitional column is not permission to execute unassociated operations.
4. Deploy only code compatible with the transitional schema, and verify it cannot enqueue or execute operations without an explicit tenant-owned connection.

The exact DDL, index strategy, constraint validation mode, and Prisma migration representation must be reviewed against the real database before this phase is implemented.

### 2. Backfill from the reviewed mapping

1. Apply only the approved operation-ID-to-connection-ID mapping. Never select the first active connection, infer by provider type alone, or use a tenant-wide default without authoritative evidence.
2. Backfill in bounded, restartable batches using a stable key order and record counts per batch.
3. Before each update, verify the target connection belongs to the same tenant as the operation. Stop and quarantine any mismatch rather than bypassing the check.
4. Preserve a protected before/after audit record of operation ID, tenant ID, selected connection ID, mapping evidence reference, and reviewer. Never include secrets.
5. Re-run counts and integrity checks after each batch. The backfill must be idempotent and must not overwrite a previously reviewed, conflicting association.

**Gate:** every operation that can be executed must have an individually justified connection mapping; unresolved operations remain blocked from execution.

### 3. Validate and contract

1. Verify there are no null connection IDs among records in scope, no missing referenced connections, and no tenant mismatch.
2. Verify the mapping count matches the reviewed inventory and investigate every discrepancy.
3. Confirm PostgreSQL enforces the tenant-consistent composite foreign key, not only an application-level check.
4. After the backfill is validated, make the column non-null and apply the final constraints/indexes in a separately reviewed migration.
5. Deploy code that requires the explicit connection ID and resolves it against the job tenant and active connection status immediately before adapter invocation.
6. Keep concrete provider adapters disabled until the adapter contract, idempotency behavior, and reconciliation tests are accepted.

### 4. Post-rollout verification

- Compare pre/post row counts by status and tenant.
- Confirm no operation was reassigned to a different provider account without an approved mapping.
- Test tenant A cannot create, resolve, or execute an operation using tenant B's connection.
- Test inactive/revoked connections fail closed before executor invocation.
- Test `UNKNOWN` operations cannot be retried until explicit reconciliation.
- Review application and database logs for leaked credentials or sensitive payloads.
- Retain the migration report and approval record according to the platform's audit policy.

## Rollback strategy

Rollback must be designed against the actual database engine/version and deployment topology before execution.

- If the expand phase fails before backfill, stop dispatch, restore compatible application code, and remove only newly added structures if they are proven unused and removal is safe.
- If backfill partially completes, do not blindly reverse or overwrite associations. Stop dispatch, retain the mapping/audit report, and resume or repair from the approved mapping after review.
- If the contract phase fails, do not drop or relax constraints automatically. Keep dispatch paused and resolve the specific violating rows, or restore the pre-change snapshot under the approved recovery procedure.
- A database restore may lose writes after the snapshot; the owner must explicitly assess and approve that consequence.
- Never use a rollback that re-enables blind retries for operations whose provider outcome is unknown.

## Release checklist

- [ ] Target schema and migration history inspected
- [ ] Backup restored successfully in isolation
- [ ] Provider-operation inventory reconciled
- [ ] Explicit connection mapping reviewed; unresolved records quarantined
- [ ] Expand migration reviewed for lock and compatibility risks
- [ ] Dispatch paused or guarded during transitional state
- [ ] Backfill is batched, restartable, and tenant-checked
- [ ] Row counts and composite-constraint verification pass
- [ ] Final non-null constraint migration reviewed
- [ ] Adapter and reconciliation contract tests pass
- [ ] Rollback/recovery owner and maintenance window approved
- [ ] No production deployment until all gates are signed off
