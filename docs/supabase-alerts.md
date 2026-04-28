# Supabase alerts runbook

Operator-side procedures for the Supabase project that backs Minsky
(`yvkkrpyjhoiilmizlnac` — `minsky (dev 2)` in West US Oregon).

## When to use this runbook

- After project creation: provision the standard alert rules.
- After incidents: re-confirm rules survived (Supabase rule storage has had migration glitches in the past).
- When tuning thresholds: track changes here so the runbook reflects current intent, not history.

The 2026-04-28 disk-I/O exhaustion incident — three concurrent `transcripts ingest --all` runs (mt#1419) plus 25 zombie `minsky mcp start` processes (mt#1417) cumulatively burned the I/O budget on the Free tier — is the originating incident for these rules. Goal: 70% threshold fires the operator email _before_ the cliff so we have time to act.

## Standard rule set

| #   | Metric                  | Threshold                                   | Severity | Notes                                |
| --- | ----------------------- | ------------------------------------------- | -------- | ------------------------------------ |
| 1   | Disk IO budget consumed | 70%                                         | warning  | First chance to act before throttle  |
| 2   | Disk IO budget consumed | 90%                                         | critical | Cliff-imminent — page-class signal   |
| 3   | Database connections    | ~80 (≈80% of `max_connections=60` post-Pro) | warning  | Catch zombie-connection accumulation |
| 4   | Disk space used         | 80%                                         | warning  | Slow-burn, separate from IO          |
| 5   | Egress bandwidth        | tier-dependent                              | warning  | Set to 70% of monthly tier quota     |

> Rules 4 and 5 are extensions of the original two-rule set. Add as project grows.

## Setting up the rules

### Option A: Dashboard (canonical, manual)

1. Open https://supabase.com/dashboard/project/yvkkrpyjhoiilmizlnac/settings/notifications
2. **Add notification rule** → Email channel → metric / threshold / severity per the table above.
3. Save each rule individually.

### Option B: Management API (scripted, drift-resistant)

This is the path the runbook eventually wants — single source of truth in this repo, idempotent provisioning. It is **not yet end-to-end automated**: the `POST /notifications` body schema needs to be discovered and pinned. mt#1422 is the task that finishes this.

Prerequisite: a Supabase Personal Access Token in `SUPABASE_ACCESS_TOKEN` env. Source from the Supabase CLI's stored token (one-line in your shell rc):

```bash
export SUPABASE_ACCESS_TOKEN="$(cat "$HOME/Library/Application Support/supabase/access-token")"
```

Or generate a scoped PAT at https://supabase.com/dashboard/account/tokens and paste it in.

Once set, list current rules:

```bash
just supabase-alerts-list
```

This is the discovery step. The response shape from `GET /v1/projects/{ref}/notifications` shows the field names and enums needed to build a `POST` body. mt#1422 captures the full create/update flow once the schema is pinned.

## Verifying after a project restart

The 2026-04-28 incident bounced the instance via Pro upgrade + compute restart. After any restart:

```bash
# 1. Confirm DB accepts connections
just supabase-health

# 2. Confirm rules survived
just supabase-alerts-list

# 3. Confirm the role-level safety nets are still in place (statement_timeout, idle_in_transaction)
# Run this through the Minsky MCP supabase tool, not via CLI:
#   mcp__supabase__execute_sql query="SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'postgres';"
#   Expected: statement_timeout=30s
#   mcp__supabase__execute_sql query="SELECT datname, setconfig FROM pg_db_role_setting JOIN pg_database ON pg_database.oid = setdatabase WHERE datname = 'postgres';"
#   Expected: idle_in_transaction_session_timeout=60s
```

If either timeout setting is missing, re-apply via `mcp__supabase__execute_sql`:

```sql
ALTER ROLE postgres SET statement_timeout = '30s';
ALTER DATABASE postgres SET idle_in_transaction_session_timeout = '60s';
```

## Related tasks

- **mt#1421** — parent: infrastructure cost awareness (Supabase + Railway)
- **mt#1422** — automate the Management API rule provisioning (TODO)
- **mt#1417** — MCP subprocess leak (the contributor that pushed I/O over budget today)
- **mt#1419** — atomic upsert in AgentTranscriptIngestService (the other contributor)
- **mt#1393** — parent of mt#1421: cost/limit-aware capacity (AI providers + infra)

## Related operator docs

- `docs/deploy-minsky-railway.md` — Railway deploy of the MCP server (also pulls from this Supabase project)
- `memory/feedback_railway_config.md` — Railway operational gotchas
- `memory/project_minsky_mcp_deployment.md` — Service IDs and dashboard URLs
