# Switching to the dedicated PgBouncer pooler

Operator runbook for moving Minsky's database connections from the **shared Supavisor pooler** to the **dedicated PgBouncer instance** that's co-located with the Minsky Supabase project (`yvkkrpyjhoiilmizlnac`).

## Why switch

- **Lower latency** — same VPC as your DB.
- **Higher connection ceiling that isn't shared with other tenants.**
- **Full prepared-statement support** — Supavisor transaction mode has limited prepared-statement support; Drizzle ORM (which Minsky uses) emits prepared statements freely. This was a quiet correctness risk on Supavisor.
- **Predictable behavior under load** — shared poolers can throttle when neighbors get noisy. The 2026-04-28 incident showed how a noisy local workload could exhaust shared infra.

## What's already provisioned

Every Supabase project on Micro Compute and above has a dedicated PgBouncer running alongside the shared Supavisor. The dedicated PgBouncer for this project is reachable at:

- **Host:** `db.yvkkrpyjhoiilmizlnac.supabase.co`
- **Port:** `6543` (port 5432 on the same host is direct PostgreSQL — no pooler)
- **User:** `postgres` (NOT `postgres.<project-ref>` — that's the Supavisor convention)
- **Pool mode:** `transaction` (matches what we configured for Supavisor; safe to leave)

Compute upgrade is NOT required; Micro is sufficient.

## The switch (three places)

### 1. Local `~/.config/minsky/config.yaml`

Find the line:

```yaml
persistence:
  postgres:
    connectionString: postgresql://postgres.yvkkrpyjhoiilmizlnac:<password>@aws-0-us-west-2.pooler.supabase.com:6543/postgres
```

Change to:

```yaml
persistence:
  postgres:
    connectionString: postgresql://postgres:<same-password>@db.yvkkrpyjhoiilmizlnac.supabase.co:6543/postgres
```

Two changes: username `postgres.yvkkrpyjhoiilmizlnac` → `postgres`, host `aws-0-us-west-2.pooler.supabase.com` → `db.yvkkrpyjhoiilmizlnac.supabase.co`. Password and port stay the same.

### 2. Railway: Minsky MCP service

Service ID: `a7c5195f-55de-472a-87e4-34e921a15171` (per `project_minsky_mcp_deployment.md`).

Update env vars (whichever are set; check both):

```bash
railway variables --set MINSKY_SESSIONDB_POSTGRES_URL='postgresql://postgres:<password>@db.yvkkrpyjhoiilmizlnac.supabase.co:6543/postgres'
railway variables --set MINSKY_POSTGRES_URL='postgresql://postgres:<password>@db.yvkkrpyjhoiilmizlnac.supabase.co:6543/postgres'
```

Trigger redeploy; verify health endpoint:

```bash
curl https://minsky-mcp-production.up.railway.app/health
# expect: {"status":"ok",...}
```

### 3. Railway: reviewer service

Service ID: `3913e8a4-81ab-465a-aad8-b76b5e3f66ed` (per `project_minsky_mcp_deployment.md`). Same env-var changes as the MCP service. Same redeploy + health-check verification.

## Verification post-switch

After all three are switched, confirm via the local CLI:

```bash
minsky tasks list
# Should return real data; if it errors with "auth failed" the user/host swap was inconsistent.

# DB-side check via Minsky MCP supabase tool:
#   mcp__supabase__execute_sql query="SELECT inet_client_addr(), application_name FROM pg_stat_activity WHERE application_name ILIKE '%postgres-js%' OR application_name = 'minsky' LIMIT 5;"
# application_name should mention postgres-js (the driver). client_addr now reflects PgBouncer's address.
```

## Rolling back

If anything regresses, swap back to the Supavisor connection string in the same three places. Both poolers run in parallel; neither switch deletes the other's auth path.

## What does NOT change

- DB password (same).
- Pool mode (transaction in both).
- `statement_timeout=30s` and `idle_in_transaction_session_timeout=60s` (these are role/database settings, applied at the DB layer, independent of pooler).
- Notification rules (separate concern, see `docs/supabase-alerts.md`).

## Related tasks

- mt#1421 — parent: infrastructure cost awareness
- mt#1422 — was Management API alert-rule provisioning; re-scoped on 2026-04-28 to "Metrics API scraping for self-hosted alerting" since the public API doesn't expose notification CRUD
- mt#1426 — credential entry surface (so future connection-string changes don't require operator-level YAML editing)
- mt#1427 — MCP-cached-config-vs-file-edit drift (relevant: after the local config change, MCP needs reload to pick it up)
