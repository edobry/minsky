# Plan: Automated Migrations Strategy (Boot-time/Orchestrated) and Remote Runs

## Context

Migrations are currently user-triggered with dry-run-by-default and fail-fast detection (Postgres). We want a safe, automated path for applying schema changes in environments like Docker/Kubernetes/remote runners while preserving operational control.

## Goals

- Define approaches to automate migrations without surprises
- Integrate with container/orchestrator lifecycle (Docker, Kubernetes)
- Enforce safety (locks/serial execution), observability, and rollbacks
- Remain compatible with Drizzle migrator + generated SQL migrations

## Candidate Approaches

1) Application boot-time migrator (opt-in)
- App checks pending migrations on start; if `MINSKY_DB_AUTO_MIGRATE=true`, acquires lock and applies
- Pros: Simple, no extra infra
- Cons: Risk of multiple instances racing; needs robust locking + timeouts

2) Orchestrator-driven job (preferred for k8s)
- Kubernetes Job or Helm hook runs migrator prior to Deployment rollout
- Uses single-run pod with DB credentials; exits on success before app pods start
- Pros: Strong isolation, easy audit, predictable ordering
- Cons: Requires cluster integration and release flow changes

3) Init container in k8s Deployment
- Init container runs Drizzle migrations before main container starts
- Pros: Co-located with app spec
- Cons: Not ideal for multi-replica rollouts (init runs once per pod) unless gated via lock

4) Sidecar/Operator pattern
- Dedicated migrator sidecar/operator watches for new images/versions and applies migrations
- Pros: Centralized control
- Cons: More infra surface area

## Concurrency & Safety

- Advisory DB locks (e.g., Postgres `pg_advisory_lock`) to serialize migrator
- Strict timeouts and backoff to avoid deadlocks
- Version pinning: Only apply migrations compatible with current app version
- Dry-run preview mode for CI/staging

## Observability & Ops

- Structured logs with migration IDs, timing, results
- Metrics: counts, durations, last-applied version, failures
- Status tables (Drizzle meta) + health endpoint exposing migration state

## Rollbacks & Windows

- Treat irreversible migrations with caution; require manual flag for `unsafe` ops
- Document maintenance windows for high-impact migrations
- Gate rollouts on successful migrations; fail fast on pending/failed state

## Remote Runs (Docker/Kubernetes)

- Docker: entrypoint wrapper supporting `MINSKY_DB_AUTO_MIGRATE` and `MINSKY_DB_DRY_RUN`
- Kubernetes: Helm chart templates for Job/InitContainer variants; config flags for enabling/disabling
- Secrets and RBAC for migration job service account

## Implementation Notes

- Reuse existing Drizzle migrators (postgres-js/bun-sqlite)
- Keep dry-run-by-default principle; require explicit env/flag for apply
- Integrate with current `sessiondb.migrate` for consistent behavior

## Deliverables

- ADR: Migration automation strategy with chosen defaults per environment
- POCs: Docker entrypoint mode; k8s Job template with advisory lock
- Docs: Ops runbooks, env flags, Helm values and examples

## Open Questions

- Multi-tenant DBs and scoped migrations
- Online DDL / zero-downtime strategies for large tables
- Handling extensions (pgvector) lifecycle in automated flows

## Links

- Related plans: md#418 (Postgres→Postgres migration), md#419 (SQLite→PGlite exploration)
