# scripts/

Utility, verification, and one-off scripts for Minsky. These are not part of the main
application (`src/`, `packages/`) but support development, deployment, and live
verification. Classification below checks each script against `package.json` `scripts`
and `.github/workflows/*.yml` before calling it "wired" — see mt#2610.
Index last audited: 2026-07-06 (mt#2610 dead-code sweep).

## Operator tools (invoked directly, part of the normal dev/build/deploy flow)

| Script                           | Description                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-entry.ts`                   | Bin entry for the `minsky` CLI (mt#1740). Referenced by `package.json`'s `bin` and `postinstall`.                                                                                                                                               |
| `build-completion-manifest.ts`   | Builds the shell-completion manifest by force-loading the CLI command tree. Wired: `bun run build:completion-manifest`.                                                                                                                         |
| `check-variable-naming.ts`       | Checks codebase for non-ASCII variable/symbol names.                                                                                                                                                                                            |
| `fix-variable-naming.ts`         | Auto-fixes non-ASCII variable names found by `check-variable-naming.ts`.                                                                                                                                                                        |
| `create-github-app.ts`           | Creates a GitHub App via the manifest flow. Canonical user-facing path is `minsky setup github-app` (mt#1087) — this is the underlying script.                                                                                                  |
| `deploy-minsky-mcp.ts`           | Deployment helper for the hosted Minsky MCP server on Railway (mt#1130).                                                                                                                                                                        |
| `drizzle-config-loader.ts`       | Loads DB credentials from Minsky config for `drizzle-kit` (works around its lack of top-level-await support).                                                                                                                                   |
| `generate-bootstrap-snapshot.ts` | Regenerates the fresh-DB bootstrap snapshot (mt#2439). Wired: `bun run db:generate:bootstrap-snapshot`.                                                                                                                                         |
| `generate-icons.ts`              | Generates icon assets from `assets/icon/minsky-icon.svg`. Wired: `bun run icons:generate`.                                                                                                                                                      |
| `set-branch-protection.ts`       | Applies the mt#1938 branch-protection config to `edobry/minsky:main`. Dry-run by default; `--execute` to apply. Canonical audit-logged write path (see CLAUDE.md `§Turnkey, not portal`).                                                       |
| `grant-subagent-merge.ts`        | Orchestrator-side surface for issuing an ADR-028 D5 subagent merge-capability grant (mt#2651). Writes a TTL-bound grant to the shared store `.minsky/hooks/block-subagent-merge-without-grant.ts` checks. `--dry-run` previews without writing. |

## CI-wired verification

Directly invoked from a `.github/workflows/*.yml` step (not via a `package.json` script).

| Script                          | Wired from                                         | Description                                                                   |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `smoke-cold-start-migrate.ts`   | `.github/workflows/cold-start-migrate.yml`         | Verifies `minsky persistence migrate --execute` against a fresh DB (mt#2369). |
| `post-deploy-health-monitor.ts` | `.github/workflows/post-deploy-health-monitor.yml` | Checks every deployed Railway service's post-deploy health (mt#1302).         |

## package.json-wired smoke tests

| Script                           | npm script            | Description                                                                 |
| -------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `smoke-mt2245-github-timeout.ts` | `smoke:gh-timeout`    | Verifies bounded Octokit network timeout (mt#2245).                         |
| `smoke-oauth-consent-https.ts`   | `smoke:oauth-consent` | Verifies the OAuth consent flow renders HTTPS behind a TLS proxy (mt#1780). |

## Manual live-verification / smoke scripts (env-gated, run on demand)

Not wired into CI or `package.json` — these follow the `/implement-task` §7a
"verification artifact" convention: shipped alongside a structural change, gate on
required env vars (skip gracefully without them), and are run manually post-merge or
pasted into a PR body as execution evidence (mt#1399 / mt#1403 pattern). Each is scoped
to one task; the task ID in the name or header is the primary cross-reference.

| Script                                   | Verifies (task)                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `smoke-asks-wait.ts`                     | `asks_wait-for-response` end-to-end (mt#2266)                                                 |
| `smoke-cli-outside-repo.ts`              | repo-orthogonal CLI commands from outside a repo (mt#1428)                                    |
| `smoke-mcp-disconnect.ts`                | MCP disconnect tracking (mt#1645)                                                             |
| `smoke-mcp-discovery.ts`                 | MCP-bridge discovery loop (mt#2010)                                                           |
| `smoke-mcp-server-status.ts`             | hosted MCP-server status widget (mt#2077)                                                     |
| `smoke-memory-domain-routing.ts`         | memory domain vector storage routing (mt#1605)                                                |
| `smoke-mt2401-cockpit-deploy-config.ts`  | cockpit-preview `deploy.config.ts` real Railway IDs (mt#2401)                                 |
| `smoke-no-postgres-boot.ts`              | no-Postgres boot-tolerance contract (mt#2349)                                                 |
| `smoke-post-deploy-health-monitor.ts`    | post-deploy health monitor check logic against live Railway (mt#1302)                         |
| `smoke-presence-claims.ts`               | presence-claims substrate upsert/list/reap lifecycle (mt#2562)                                |
| `smoke-prod-state-cache.ts`              | prod-state cache refresh producer (mt#2506)                                                   |
| `smoke-projects-scoping-migration.ts`    | projects-scoping migration, both paths (mt#2415 / mt#2391)                                    |
| `smoke-railway-metrics.ts`               | first-party Railway service-metrics + restart-count queries (mt#2296)                         |
| `smoke-retrigger-default-url.ts`         | drift guard for `reviewer.retrigger`'s default webhook URL (mt#2359)                          |
| `smoke-reviewer-watch.ts`                | local reviewer-bot watcher against live GitHub API (mt#1310)                                  |
| `smoke-session-crud.ts`                  | `DrizzleSessionRepository` CRUD path (mt#2329)                                                |
| `smoke-setup-db.ts`                      | `minsky setup db` onboarding against a live Postgres (mt#2429)                                |
| `smoke-skill-staleness-hook.ts`          | skill-staleness-detector hook entrypoint (mt#1622)                                            |
| `smoke-tab-watcher.sh`                   | tab-watcher daemon foreground run + snapshot assertion                                        |
| `smoke-task-id-reuse.ts`                 | task-ID-reuse / orphaned-spec fix (mt#2205)                                                   |
| `smoke-task-kinds.ts`                    | task kind system (mt#1812)                                                                    |
| `smoke-transcript-ingest-hook.ts`        | SessionEnd transcript-ingest hook (mt#2192)                                                   |
| `smoke-transcript-sweep.ts`              | cockpit-daemon transcript sweep backstop (mt#2321)                                            |
| `smoke-transcript-watcher.ts`            | cockpit-daemon transcript watcher (mt#2320)                                                   |
| `smoke-validate-typecheck-workspaces.ts` | `validate.typecheck` multi-workspace coverage (mt#2256)                                       |
| `smoke-wrong-id-space.ts`                | cockpit wrong-id-space fail-loud surface (mt#2525 / mt#2420)                                  |
| `live-verify-presence-write.ts`          | `writeTaskClaim` per-call repo fallback path (mt#2567)                                        |
| `test-provenance-e2e.ts`                 | `AuthorshipJudge` against a real Claude Code JSONL transcript via the Anthropic API (mt#1081) |
| `verify-conversation-renderer.ts`        | conversation-element parser against a real session snapshot (mt#2374)                         |
| `verify-mt1510-identity-routing.ts`      | `identity` parameter on `session_pr_review_submit` (mt#1510)                                  |
| `verify-mt1721-detectors-mcp.ts`         | `registerDetectorsTools` MCP surface (mt#1721)                                                |

## One-shot backfills / migrations / repairs (already executed; kept for reference)

Ran once against production data. Kept as documentation of the migration and for
reproducibility if the same class of drift recurs — not part of any ongoing pipeline.

| Script                                     | Description                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `asks-backlog-triage.ts`                   | One-time triage of the `detected` asks backlog (mt#2265).                                    |
| `backfill-agent-transcript-attachments.ts` | Populates `agent_transcript_attachments` for transcripts ingested before mt#2022 shipped.    |
| `backfill-memory-associations.ts`          | Backfills memory associations from body-text cross-references.                               |
| `import-claude-code-memory.ts`             | One-shot importer: Claude Code harness-private memory -> Minsky DB.                          |
| `migrate-task-kinds.ts`                    | One-shot backfill: classify tasks as `kind="umbrella"` or `kind="implementation"` (mt#1812). |
| `repair-stranded-pr-open-sessions.ts`      | One-shot repair: sessions stuck in PR_OPEN with closed-merged PRs (mt#1614).                 |

## Measurement / benchmark / monitoring

| Script                                      | Description                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `measure-adapter-costs.ts`                  | Measures incremental cost of each MCP adapter file after shared commands load.                                       |
| `measure-cold-start.ts`                     | Cold-start measurement: bundle vs raw-source perf delta (mt#1740).                                                   |
| `measure-mcp-start-cold-start.ts`           | Cold-start measurement for the `mcp start` path specifically (mt#1745). Output: `mcp-start-cold-start-results.json`. |
| `measure-source-only.ts`                    | Quick source-path-only cold-start measurement (mt#1792).                                                             |
| `benchmark-mcp-memory-enrichment.ts`        | Latency benchmark for memory-enrichment middleware (mt#1588 spike).                                                  |
| `calibrate-epic-decomposition-staleness.ts` | Calibration script for the mt#1710 Shape C detector against live Postgres.                                           |
| `monitor-reviewer-health.ts`                | Pulls the minsky-reviewer GitHub App's webhook delivery history for health monitoring.                               |
| `mcp-start-cold-start-results.json`         | Output data from `measure-mcp-start-cold-start.ts` (not a script).                                                   |

## Historical research (not code)

| File              | Description                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poc-findings.md` | mt#216 PoC findings memo: running Minsky outside Claude Code. The PoC's driver script (`poc-agent-loop.ts`) was removed as dead code (mt#2610); this findings memo remains as the standalone research artifact it documents. |

## lib/

Shared utilities used by scripts above.

| Module             | Description                         |
| ------------------ | ----------------------------------- |
| `lib/pem-utils.ts` | PEM key parsing/formatting helpers. |

## supabase/

Supabase Management API helpers.

| Script                        | Description                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/restart-project.ts` | Self-serve Supabase project restart via Management API (`POST /v1/projects/{ref}/restart`). Dry-run by default; pass `--execute` to actually restart. Required to reset the Supavisor auth-failure circuit breaker — a fast DB reboot alone is NOT sufficient. See mt#2574 and `docs/incidents/2026-06-28-supabase-connectivity-breaker.md`. |
