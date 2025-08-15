# Automated Migrations Strategy (Boot-time/Orchestrated) and Remote Runs

## Context

Plan automated migrations for DB schema in remote-run contexts.\n\nScope:\n- Compare strategies: boot-time migrator vs k8s Job/Init vs operator\n- Safety: advisory locks, timeouts, dry-run by default, explicit apply\n- Observability: logs/metrics/status, rollback policy, windows\n- Orchestrator integration: Docker entrypoint flags, Helm values, k8s RBAC\n- Drizzle migrator reuse; consistent with sessiondb.migrate semantics\n\nDeliverables:\n- ADR, POCs (Docker/k8s), docs/runbooks\n- Recommendation + rollout plan\n

## Requirements

## Solution

## Notes
