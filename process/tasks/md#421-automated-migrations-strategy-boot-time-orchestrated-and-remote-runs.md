# Automated Migrations Strategy (Boot-time/Orchestrated) and Remote Runs

## Context

Plan automated migrations for DB schema in remote-run contexts.

Scope:
- Compare strategies: boot-time migrator vs k8s Job/Init vs operator
- Safety: advisory locks, timeouts, dry-run by default, explicit apply
- Observability: logs/metrics/status, rollback policy, windows
- Orchestrator integration: Docker entrypoint flags, Helm values, k8s RBAC
- Drizzle migrator reuse; consistent with sessiondb.migrate semantics

Deliverables:
- ADR, POCs (Docker/k8s), docs/runbooks
- Recommendation + rollout plan


## Requirements

## Solution

## Notes
