# Supabase alerts runbook

Operator-side procedures for the Supabase project that backs Minsky
(`yvkkrpyjhoiilmizlnac` — `minsky (dev 2)` in West US Oregon).

## When to use this runbook

- After project creation: provision the standard alert rules.
- After incidents: re-confirm rules survived (Supabase rule storage has had migration glitches in the past).
- When tuning thresholds: track changes here so the runbook reflects current intent, not history.

The 2026-04-28 disk-I/O exhaustion incident — three concurrent `transcripts ingest --all` runs (mt#1419) plus 25 zombie `minsky mcp start` processes (mt#1417) cumulatively burned the I/O budget on the Free tier — is the originating incident for these rules. Goal: 70% threshold fires the operator email _before_ the cliff so we have time to act.

## Standard rule set

| #   | Metric                  | Threshold                                     | Severity | Notes                                                                             |
| --- | ----------------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| 1   | Disk IO budget consumed | 70%                                           | warning  | First chance to act before throttle                                               |
| 2   | Disk IO budget consumed | 90%                                           | critical | Cliff-imminent — page-class signal                                                |
| 3   | Database connections    | **48** (80% of `max_connections=60` on Micro) | warning  | Catch zombie-connection accumulation; raise proportionally if compute is upgraded |
| 4   | Disk space used         | 80%                                           | warning  | Slow-burn, separate from IO                                                       |
| 5   | Egress bandwidth        | tier-dependent                                | warning  | Set to 70% of monthly tier quota                                                  |

> Rules 4 and 5 are extensions of the original two-rule set. Add as project grows.

## Setting up the rules

### Option A: Dashboard (canonical, manual)

1. Open https://supabase.com/dashboard/project/yvkkrpyjhoiilmizlnac/settings/notifications
2. **Add notification rule** → Email channel → metric / threshold / severity per the table above.
3. Save each rule individually.

### Option B: Management API (NOT AVAILABLE — confirmed 2026-04-28)

The public Supabase Management API does not expose notification-rule CRUD. Empirical verification (2026-04-28): all 107 endpoints in `/api/v1/openapi.json` reviewed; zero match `notif` or `alert`. Tested paths `/v1/projects/{ref}/notifications`, `/api/v1/projects/{ref}/notifications`, `/platform/projects/{ref}/notifications` — all 404 or 401. The dashboard's notification rules page uses a separate dashboard-internal API not exposed publicly.

**The only programmatic alternative** is to scrape Supabase's Prometheus-compatible Metrics API (~200 Postgres health metrics) into your own time-series store and configure alerts in Prometheus / Grafana / a custom cockpit panel. This is significantly more work than the dashboard but more flexible. Tracked as a sibling of mt#1422.

Practically: **set the rules in the dashboard (Option A above).** mt#1422 has been re-scoped accordingly.

### Operator JSON-source-of-truth for dashboard rules

To keep the dashboard config in this repo as a checkable artifact, the runbook documents the canonical rule set in the table above. After any future dashboard change, paste the rules' JSON (you can copy from the dashboard's network tab) into `docs/supabase-alerts.json` so the source-of-truth lives next to the rest of the operator config.

That file isn't shipped yet — it's a follow-up; for now the table in this doc is the canonical reference.

## Verifying after a project restart

The 2026-04-28 incident bounced the instance via Pro upgrade + compute restart. After any restart:

```bash
# 1. Confirm DB accepts connections
just supabase-health

# 2. Confirm rules survived (dashboard check — no public API for this)
#    Open https://supabase.com/dashboard/project/yvkkrpyjhoiilmizlnac/settings/integrations
#    and verify the standard rule set above is present and active.

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
