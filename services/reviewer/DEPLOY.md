# Deploying minsky-reviewer to Railway

Stateless Node service. Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely. Any Node-compatible host works — the service is stateless beyond its environment variables.

## Prerequisites (one-time, user action)

1. **Railway CLI** installed locally (`bash <(curl -fsSL cli.new)` or `brew install railway`).
2. **Railway account** with a workspace you can deploy under.
3. **`minsky-reviewer` GitHub App** created (mirror the setup from `docs/github-app-bot-setup.md` with the permissions listed in `README.md`).
4. **Webhook secret** generated: `openssl rand -hex 32`.
5. **Model-provider API key** for whichever provider you chose:
   - OpenAI (`OPENAI_API_KEY`) — default, GPT-5
   - Google (`GOOGLE_AI_API_KEY`) — Gemini 2.5 Pro
   - Anthropic (`ANTHROPIC_API_KEY`) — fallback, captures only context-isolation benefit

## First deploy

> **Important (post-mt#1681):** Railway commands must run from the **repo root**, not from `services/reviewer/`. The Dockerfile assumes repo-root build context (it COPYs both `packages/shared/` and `services/reviewer/`); running `railway init`/`railway up` from the subdirectory will set the wrong context and fail or build a broken image. After `railway init`, immediately set the service config so subsequent builds match the Dockerfile expectation — see "Configure for repo-root build context" below.

From the repo root:

```bash
cd /path/to/minsky        # repo root, NOT services/reviewer
railway login
railway init --name minsky-reviewer

# Configure for repo-root build context BEFORE the first build
railway status --json     # note the service-id from the output
cat <<'EOF' | railway environment edit --json
{"services":{"<service-id>":{"source":{"rootDirectory":""},"build":{"dockerfilePath":"services/reviewer/Dockerfile"}}}}
EOF

railway up --detach -m "Initial deploy"
```

## Set environment variables

```bash
railway variable set MINSKY_REVIEWER_APP_ID=<numeric-app-id>
railway variable set MINSKY_REVIEWER_PRIVATE_KEY="$(cat ~/.config/minsky/minsky-reviewer.pem)"
railway variable set MINSKY_REVIEWER_INSTALLATION_ID=<numeric-install-id>
railway variable set MINSKY_REVIEWER_WEBHOOK_SECRET=<secret-from-openssl>

railway variable set REVIEWER_PROVIDER=openai
railway variable set OPENAI_API_KEY=<your-key>

# REQUIRED: Postgres connection for the convergence-metrics schema. The
# service reads MINSKY_SESSIONDB_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL)
# at startup via src/db/client.ts and applies drizzle migrations from
# services/reviewer/migrations/pg before opening the webhook listener. If
# neither is set, the service falls back to a dev-only
# `postgresql://localhost:5432/minsky` URL and the container crash-loops on
# the first migration query (no Postgres listening inside the container).
#
# Use the same connection string you have at
# `~/.config/minsky/config.yaml` → `persistence.postgres.connectionString`.
# The Supabase transaction-mode pooler endpoint (port 6543) is confirmed
# working for these migrations as of 2026-05-02 (mt#1556).
railway variable set MINSKY_SESSIONDB_POSTGRES_URL=<your-supabase-postgres-url>

railway variable set MINSKY_REVIEWER_TIER2_ENABLED=false
```

### Recovery layer activation (mt#1614 + mt#1811)

The reviewer service hosts mt#1614's post-merge state-sync recovery layer: a
`pull_request.closed && merged=true` webhook handler plus a 10-minute sweeper
backstop. Both paths invoke `apply_post_merge_state_sync` on the Minsky MCP
server to transition merged PRs from IN-REVIEW → DONE (and apply the full
session state-sync). Without these env vars no state-sync occurs — but the
service logs explicit signals so operators can detect the misconfiguration:
`at_merge_handler.mcp_not_configured` on each missed webhook and
`merge_state_sweeper.missing_credentials` once at boot. Originating incident:
mt#1811 — four PRs bypass-merged 2026-05-12 failed to auto-sync because MCP
credentials and/or the sweeper toggle were unset on the deployed service.

```bash
# REQUIRED for the recovery layer to function. Both must be set together.
# - MINSKY_MCP_URL: HTTPS endpoint of the Minsky MCP server (hosted form).
# - MINSKY_MCP_AUTH_TOKEN: bearer token issued by the Minsky MCP server. Same
#   name on both sides (server: services/minsky-mcp; client: this).
# Without these, the webhook handler logs "at_merge_handler.mcp_not_configured"
# and skips (silent no-op); the sweeper logs "merge_state_sweeper.missing_credentials"
# and refuses to start. The PR will be left stranded at IN-REVIEW until manual sync.
railway variable set MINSKY_MCP_URL=<https://your-minsky-mcp-host/mcp>
railway variable set MINSKY_MCP_AUTH_TOKEN=<bearer-token-from-minsky-mcp>

# OPTIONAL — sweeper is enabled by default (mt#1811). Set to "false" only if
# you want to disable the 10-minute backstop sweep entirely.
# railway variable set MERGE_STATE_SWEEPER_ENABLED=false

# OPTIONAL — sweeper cadence. Default 600000 (10 min). Smaller values increase
# how quickly the backstop catches a webhook-missed merge.
# railway variable set MERGE_STATE_SWEEPER_INTERVAL_MS=600000
```

Verify activation after deploy: tail `railway logs --service minsky-reviewer-webhook`
and confirm you see `{"event":"merge_state_sweeper.started", ...}` shortly after
service start. If you see `merge_state_sweeper.missing_credentials` or
`merge_state_sweeper.disabled` instead, the recovery layer is NOT active and
bypass-merge PRs will not auto-sync.

#### Reliability budget (mt#1810)

The recovery layer carries a measurable reliability target so the next drift instance
surfaces via threshold-exceeded escalation, not anecdotal recurrence:

> **At-merge auto-sync must hit DONE within ≤5 min for ≥9 of the last 10 bypass-merged
> Minsky PRs.** If 2+ misses in a 10-PR rolling window are observed (i.e., < 80%),
> escalate by filing a new task tracking **option (e)** — extend the mt#1787 bundle-boot
> smoke check to fail when `MINSKY_MCP_URL` / `MINSKY_MCP_AUTH_TOKEN` are unset on a
> reviewer deploy target. The rolling window is measured from the
> `merge_state_sweeper.cycle_end` log stream and the `tasks` DB.

A miss is defined as: `tasks_status_get` does not return `DONE` within 5 minutes of a
`gh api PUT /merge` 200 response on a Minsky-tracked PR (head branch matches `task/mt-N`
or PR body links a task ID). The 80% / 10-PR threshold is grounded in Minsky's observed
~1–3 bypass-merges per day cadence per CLAUDE.md `§Thresholds: ground in observed cadence`
— a 10-PR window covers 3–10 days of merges. Full rationale, measurement sources, and
calibration anchors live in memory entry
`Recovery-layer reliability budget for at-merge auto-sync (mt#1810)`
(id `94258ba7-aa0d-41e3-a72b-868f3bbfac90`).

After setting variables, trigger a redeploy:

```bash
railway redeploy
```

### Operator alert sink (optional — mt#2364 / mt#2419 / mt#2450)

The service can push operator alerts (circuit-breaker trips, domain-container
boot failures) to an external channel. Opt-in via:

- `ALERT_SINK_TYPE` — `telegram` or `webhook` (unset = disabled)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for `telegram`
- `ALERT_SINK_URL`, `ALERT_SINK_SECRET` — for `webhook`

On the Minsky production stack these are **Pulumi-managed** (declared in
`infra/index.ts`, gated on the per-stack `reviewer-telegram-chat-id` config) —
do NOT hand-set them in the Railway dashboard there (drift). Full setup +
verification flow: `services/reviewer/README.md §Operator alerts`.

## Generate a public URL

```bash
railway domain
```

Copy the generated `https://<service>.up.railway.app` URL.

## Register the webhook

In the `minsky-reviewer` App settings page on GitHub:

- **Webhook URL:** `https://<railway-domain>/webhook`
- **Content type:** `application/json`
- **Secret:** the value of `MINSKY_REVIEWER_WEBHOOK_SECRET`
- **SSL verification:** Enabled
- **Events subscribed to:** Pull requests

## Verify deployment

```bash
# Railway-side
railway logs --lines 50
# Look for: {"event":"server_started","port":3000,...}

# GitHub-side
curl https://<railway-domain>/health
# Expect: {"status":"ok","provider":"openai","model":"gpt-5",...}
```

## Smoke test

1. Open a test PR on a branch you can delete. Include `<!-- minsky:tier=3 -->` in the description to force the reviewer to run.
2. Observe Railway logs for a `review_result` event.
3. Check the PR — `minsky-reviewer[bot]` should have posted a review.

## Production deploy (auto-deploy from main)

> **Disclaimer:** behaviors documented below were observed during the 2026-04-22 initial deploy and the 2026-05-09 mt#1681 build-context flip on Railway CLI 4.40.2. The CLI and GraphQL API surface can change between versions, and Railway does not publish a formal schema guarantee. Verify against `railway --version` and Railway's current docs before relying on specifics — especially CLI subcommand/flag names and mutation input fields.

### Build-context shape (post-mt#1681)

The reviewer service's Dockerfile assumes the **repo root** as its build context, not `services/reviewer/`. This changed on 2026-05-09 (mt#1681) when `safeTruncate` was promoted from a vendored copy in `services/reviewer/src/utils/` to a workspace package at `packages/shared/`. The Dockerfile now needs to COPY both `packages/shared/` and `services/reviewer/` into the image, which only works with the repo root as the build context.

Current Railway service config:

| Field                  | Value                           | Notes                                                                     |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `source.rootDirectory` | `""` (empty string = repo root) | Was `services/reviewer` before mt#1681                                    |
| `dockerfilePath`       | `services/reviewer/Dockerfile`  | Set explicitly — RAILPACK auto-detect can't find it without rootDirectory |
| `builder`              | `RAILPACK`                      | Unchanged                                                                 |

Current Dockerfile (`services/reviewer/Dockerfile`) layer order:

1. `COPY package.json bun.lock ./` (repo-root manifest + lockfile)
2. `COPY packages/shared/package.json ./packages/shared/package.json`
3. `COPY services/reviewer/package.json ./services/reviewer/package.json`
4. `RUN bun install --frozen-lockfile --production --ignore-scripts`
5. `COPY packages/shared/{src,tsconfig.json}`
6. `COPY services/reviewer/{src,migrations,tsconfig.json}`
7. `CMD ["bun", "run", "services/reviewer/src/server.ts"]`

Key flags:

- `--ignore-scripts` skips the root `prepare: husky` hook. Husky is a dev-only git-hooks helper not installed under `--production`; without `--ignore-scripts` the install fails with `husky: command not found`.
- Manifest-first layer order keeps the install layer cacheable across source-only changes.

Steady state: pushes to `main` that land in the watched branch cause Railway to start a build. Whether a rebuild actually runs for a given push (path-filtered vs branch-wide) depends on Railway's internal change-detection logic for the deployment trigger, which is not publicly specified. Plan for the conservative case — rebuilds may fire on any main push, not only those touching `services/reviewer/` or `packages/shared/`.

This is configured as a Railway **deployment trigger** (GraphQL type `DeploymentTrigger`) linking the service to `edobry/minsky` branch `main`. The service-level `source.rootDirectory` tells Railway where in the repo to run the build from; combined with `dockerfilePath` it locates the Dockerfile.

### Prerequisite: grant Railway access to the repo

Railway's GitHub App must have access to `edobry/minsky`. Without this, the trigger creation fails with _"no one in the project has access to it"_.

One-time grant:

1. Visit <https://github.com/apps/railway-app/installations/new>
2. Select the `edobry` account (or the org that owns `minsky`)
3. Either _All repositories_ or _Only select repositories_ → add `edobry/minsky`
4. Click _Install_ / _Save_

### Configure the deployment trigger

> **Critical ordering gotcha** — set `source.rootDirectory` AND `dockerfilePath` on the service config via a JSON config merge BEFORE running the `deploymentTriggerCreate` mutation. Creating the trigger fires an immediate build against whatever config is currently on the service; missing config → build fails or deploys the wrong image → service crashes. This cost ~20 minutes of reviewer-service downtime on 2026-04-22 when the ordering was reversed.
>
> Apply the config merge first (note: this is a shallow document merge, not an RFC 6902 JSON Patch). The current shape (post-mt#1681) uses repo-root build context with an explicit Dockerfile path:
>
> ```bash
> cat <<'EOF' | railway environment edit --json
> {"services":{"<service-id>":{"source":{"rootDirectory":"","repo":"edobry/minsky","branch":"main"},"build":{"dockerfilePath":"services/reviewer/Dockerfile"}}}}
> EOF
> ```
>
> Verify it persisted with `railway environment config --json` before proceeding. The CLI's dot-path `--service-config source.rootDirectory ...` form was observed to silently no-op for this field on CLI 4.40.2; the JSON-merge form worked. If that silent no-op is reproducible on your install, consider filing upstream against Railway.
>
> Equivalent direct GraphQL form (used in mt#1681 to flip the existing service):
>
> ```graphql
> mutation {
>   serviceInstanceUpdate(
>     serviceId: "<service-id>"
>     environmentId: "<env-id>"
>     input: { rootDirectory: "", dockerfilePath: "services/reviewer/Dockerfile" }
>   ) {
>     id
>   }
> }
> ```

> **Note:** the project/environment/service UUIDs below are for the live `edobry` Railway deployment. Replace them with your own from `railway status --json` for any other deployment.

Project ID: `41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b`
Environment ID (production): `b3ea3f5d-8560-40ea-8824-17fe3ca0b32a`
Service ID (minsky-reviewer-webhook): `3913e8a4-81ab-465a-aad8-b76b5e3f66ed`

GraphQL mutation against `https://backboard.railway.com/graphql/v2` with a Railway bearer token:

```graphql
mutation Create($input: DeploymentTriggerCreateInput!) {
  deploymentTriggerCreate(input: $input) {
    id
    branch
    repository
    provider
  }
}
```

Variables (note: `rootDirectory` is a **service-config** field, not a trigger field — set it via the JSON config merge above, not here):

```json
{
  "input": {
    "projectId": "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
    "environmentId": "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
    "serviceId": "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    "branch": "main",
    "repository": "edobry/minsky",
    "provider": "github"
  }
}
```

The Railway CLI does not expose a first-class `trigger create` command at 4.40.x — the GraphQL path is the canonical option. Railway web UI also supports it (service settings → _Source_ → _Connect Repo_).

### What happens after a merge

1. GitHub sends a webhook to Railway when `main` moves.
2. Railway decides whether to run a build. Observed behavior on 2026-04-22: the service rebuilt even on main commits that didn't touch `services/reviewer/`, suggesting the deployment trigger is branch-wide rather than path-filtered. **Plan for this — do not assume path-filtered rebuilds.** If you need strict path filtering, configure `build.watchPatterns` separately on the service.
3. When Railway does build, it uses the Dockerfile at `services/reviewer/Dockerfile` (resolved from the explicit `dockerfilePath` in the service's `build` config; `rootDirectory: ""` means the build context is the repo root) and deploys the new image to `production`.

Railway's _Deployments_ tab in the web UI and the `railway logs` CLI show each auto-triggered build. The build metadata includes `RAILWAY_GIT_COMMIT_SHA` so you can correlate back to the merge commit.

### Verify auto-deploy

```bash
# After merging a PR that touches services/reviewer/
railway deployment list --service minsky-reviewer-webhook --limit 5 --json
# Newest entry should be status=SUCCESS and reference the recent commit.
# JSON field names may vary by CLI version — run `railway deployment list --help`
# to see the schema for your install.

curl https://<railway-domain>/health
# Confirms the new code is serving traffic.
```

If no new deployment appears within ~60s of the merge, check:

- The GitHub App grant is live (`Installed` at <https://github.com/settings/installations>)
- The deployment trigger exists (query `service.repoTriggers` via GraphQL — exact field names subject to API version)
- The merge commit actually touched a file under `rootDirectory` (if you configured `build.watchPatterns`; otherwise every main push triggers)

### Manual deploy still works

`railway up --detach` remains available for out-of-band pushes (e.g. testing uncommitted code on the production service). Prefer merge-to-main for anything reviewed; use manual deploy only for transient testing.

## Schema reconciliation (mt#1967)

The reviewer service uses a **dedicated drizzle migrations table**:
`drizzle.__drizzle_migrations_reviewer`. This is service-scoped, separate
from main Minsky's `drizzle.__drizzle_migrations`. Originating reason:
mt#1967 — drizzle's postgres-js migrator uses a timestamp comparison
(`Number(lastDbMigration.created_at) < migration.folderMillis`), not a
hash-set check, so two services sharing the same tracking table can
silently skip the older service's migrations. The reviewer's migrations
were silently skipped for an unknown duration on the deployed Supabase
until mt#1967.

### When to run the reconciliation script

- Suspecting the silent-skip class has re-surfaced (e.g., a new reviewer
  migration shipped, deploy logged `migrations_applied`, but a query
  against the new table returns `42P01 undefined_table`).
- A manual `DROP TABLE` or production-incident recovery has occurred.
- Pre-deploy diagnostic: confirm the deployed DB matches the expected
  reviewer schema before flipping a feature flag that depends on a new
  table.

The reviewer service ALSO runs the same self-check on every boot via
`verifyExpectedTables()` (added in mt#1967). The boot self-check
fail-fasts with a clear message if any expected table is missing —
crash-looping the service rather than silently degrading. The
operator-facing script below is the out-of-band complement.

### Dry-run

From `services/reviewer/`:

```bash
MINSKY_SESSIONDB_POSTGRES_URL='<your-supabase-pooler-url>' \
  bun run reconcile-schema
```

Or from the repo root with the raw invocation:

```bash
MINSKY_SESSIONDB_POSTGRES_URL='<your-supabase-pooler-url>' \
  bun services/reviewer/scripts/reconcile-schema.ts
```

Reports a structured JSON diagnostic: `presentTables`, `missingTables`,
`migrationRows`, and `outcome` (`all-present` or `missing-detected`).
Non-zero exit on `missing-detected`. Read-only — no DDL applied.

### Execute (forward-only repair)

From `services/reviewer/`:

```bash
MINSKY_SESSIONDB_POSTGRES_URL='<your-supabase-pooler-url>' \
  bun run reconcile-schema:execute
```

Or from the repo root:

```bash
MINSKY_SESSIONDB_POSTGRES_URL='<your-supabase-pooler-url>' \
  bun services/reviewer/scripts/reconcile-schema.ts --execute
```

Invokes the canonical `applyMigrations()` (same codepath the reviewer
service uses at boot). Drizzle's migrator inserts into
`drizzle.__drizzle_migrations_reviewer` as it applies each migration, so
subsequent runs (and subsequent boots) are idempotent.

The post-migration self-check runs after `migrate()` returns. If any
expected table is still missing the script exits non-zero with the
diagnostic message.

### Why the script exists alongside the boot self-check

The boot path crash-loops the service on a self-check failure. That's
the right behavior for production — fail fast, surface the alert. But
it's not a useful operator surface for diagnosing or repairing the
underlying state without a restart cycle. The script is the same
diagnostic delivered out-of-band, with a `--execute` switch that performs
the canonical repair against a chosen Postgres URL.

The boot self-check and the script call `applyMigrations()` and the same
`verifyExpectedTables()` helper, so neither codepath can drift from the
other.

## Troubleshooting

**Service boots but no webhooks arrive:** check the webhook URL in the App settings, check Railway domain is public, check the "Recent deliveries" in the App webhook settings page.

**Signature verification fails:** confirm the webhook secret is identical between Railway variables and the App webhook settings.

**Reviewer identity matches PR author:** you've configured the reviewer App ID to be the same as the implementer App. They must be distinct Apps.

**Review posts but uses Claude:** you've left `REVIEWER_PROVIDER=anthropic` which is the fallback path; switch to `openai` or `google` for real model diversity.

**Merged PRs not auto-syncing to DONE (mt#1614 recovery layer silent):** if PRs merge cleanly on GitHub but their Minsky tasks stay at IN-REVIEW, the recovery layer is not active. Tail `railway logs` and check for one of two distinct causes:

- **Missing MCP credentials** (most likely): the webhook path emits `at_merge_handler.mcp_not_configured` per missed delivery, and the sweeper emits `merge_state_sweeper.missing_credentials` once at boot. Fix by setting `MINSKY_MCP_URL` and `MINSKY_MCP_AUTH_TOKEN` per "Recovery layer activation" above.
- **Explicit opt-out**: the sweeper emits `merge_state_sweeper.disabled` once at boot. This indicates an operator set `MERGE_STATE_SWEEPER_ENABLED=false`; the webhook path may still be active. Unset the variable (or set it to `true`) to re-enable the backstop.

Originating incident: mt#1811.
