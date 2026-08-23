# scripts/

Utility, verification, and one-off scripts for Minsky. These are not part of the main
application (`src/`, `packages/`) but support development, deployment, and live
verification. Classification below checks each script against `package.json` `scripts`
and `.github/workflows/*.yml` before calling it "wired" — see mt#2610.
Index last audited: 2026-07-06 (mt#2610 dead-code sweep).

## Operator tools (invoked directly, part of the normal dev/build/deploy flow)

| Script                           | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli-entry.ts`                   | Bin entry for the `minsky` CLI (mt#1740). Referenced by `package.json`'s `bin` and `postinstall`.                                                                                                                                                                                                                                                                                            |
| `build-completion-manifest.ts`   | Builds the shell-completion manifest by force-loading the CLI command tree. Wired: `bun run build:completion-manifest`.                                                                                                                                                                                                                                                                      |
| `check-variable-naming.ts`       | Checks codebase for non-ASCII variable/symbol names.                                                                                                                                                                                                                                                                                                                                         |
| `fix-variable-naming.ts`         | Auto-fixes non-ASCII variable names found by `check-variable-naming.ts`.                                                                                                                                                                                                                                                                                                                     |
| `create-github-app.ts`           | Creates a GitHub App via the manifest flow. Canonical user-facing path is `minsky setup github-app` (mt#1087) — this is the underlying script.                                                                                                                                                                                                                                               |
| `deploy-minsky-mcp.ts`           | Deployment helper for the hosted Minsky MCP server on Railway (mt#1130).                                                                                                                                                                                                                                                                                                                     |
| `drizzle-config-loader.ts`       | Loads DB credentials from Minsky config for `drizzle-kit` (works around its lack of top-level-await support). Its stdout IS a live credential; **gated** (mt#4017) — refuses and exits non-zero unless `MINSKY_DRIZZLE_LOADER_GATE=1` is set, which only `drizzle.pg.config.ts`'s own subprocess call sets. Do not invoke directly.                                                          |
| `generate-bootstrap-snapshot.ts` | Regenerates the fresh-DB bootstrap snapshot (mt#2439). Wired: `bun run db:generate:bootstrap-snapshot`.                                                                                                                                                                                                                                                                                      |
| `generate-icons.ts`              | Generates icon assets from `assets/icon/minsky-icon.svg`. Wired: `bun run icons:generate`.                                                                                                                                                                                                                                                                                                   |
| `set-branch-protection.ts`       | Applies the mt#1938 branch-protection config to `edobry/minsky:main`. Dry-run by default; `--execute` to apply. Canonical audit-logged write path (see CLAUDE.md `§Turnkey, not portal`).                                                                                                                                                                                                    |
| `grant-subagent-merge.ts`        | Orchestrator-side surface for issuing an ADR-028 D5 subagent merge-capability grant (mt#2651). Writes a TTL-bound grant to the shared store `.minsky/hooks/block-subagent-merge-without-grant.ts` checks. `--dry-run` previews without writing.                                                                                                                                              |
| `export-gource-log.ts`           | Exports a Gource custom-log for an ingested agent session — the watchable-world Phase 0 affect probe (mt#3157). `bun scripts/export-gource-log.ts <conversationId> [--out <path>]` or `--coverage [--limit N]`; `--help` for full usage. Refuses sessions ingested before the mt#2864 credential-scrub cutoff unless `--verified-rescrubbed`. View with `gource --log-format custom <file>`. |

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
| `smoke-staleness-drain.ts`               | staleness-exit drain window admits new requests but not into the exit gap (mt#2830)           |
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
| `verify-cockpit-shell-scroll.ts`         | cockpit shell scroll/geometry invariants in a real browser (mt#3335 / mt#3338)                |
| `verify-conversation-footer-stack.ts`    | conversation bottom-edge controls stack without overlapping, in a real browser (mt#3843)      |
| `verify-conversation-live-tail.ts`       | conversation live-tail scroll behavior in a real browser (mt#3376 / mt#3445)                  |
| `verify-conversation-orientation.ts`     | conversation scroll-driven reveal + position hold in a real browser (mt#3688)                 |
| `verify-conversation-renderer.ts`        | conversation-element parser against a real session snapshot (mt#2374)                         |
| `verify-driven-session-scrollport.ts`    | driven page owns its scrollport, keeping the composer on screen, in a real browser (mt#3737)  |
| `verify-mt1510-identity-routing.ts`      | `identity` parameter on `session_pr_review_submit` (mt#1510)                                  |
| `verify-peek-pane-layout.ts`             | peek pane gutters, single scrollport and page column in a real browser (mt#4123)              |
| `verify-mt1721-detectors-mcp.ts`         | `registerDetectorsTools` MCP surface (mt#1721)                                                |
| `verify-session-film-panes.ts`           | film ribbon/stage drag + clamp and cockpit scrollbar chrome in a real browser (mt#3701)       |
| `verify-turn-write-skip-if-unchanged.ts` | turn upsert's skip-if-unchanged `setWhere` guard against real Postgres (mt#4345)              |

### Running the browser-driving scripts

These scripts drive a real browser and share one preflight
(`lib/verify-preflight.ts`, mt#4149): `verify-cockpit-navigation-latency.ts`,
`verify-cockpit-shell-scroll.ts`, `verify-conversation-footer-stack.ts`,
`verify-conversation-live-tail.ts`, `verify-conversation-orientation.ts`,
`verify-conversation-switcher-pinned.ts`, `verify-conversation-turn-target.ts`,
`verify-driven-session-scrollport.ts`, `verify-interceptors-axes-render.ts`,
`verify-peek-pane-layout.ts`, `verify-session-film-camera.ts`,
`verify-session-film-panes.ts`, and `verify-terminal-ask-render.ts`. Their shared prerequisites are
worth stating (everything below is checked at startup — an ABSENT precondition exits 0 with a
`SKIP:` line rather than failing).

**Poll in-page conditions from OUTSIDE, one `Runtime.evaluate` per attempt (mt#4123).** A
`Runtime.evaluate` binds to ONE execution context, and a context belongs to ONE document — so an
async expression that loops internally stays pinned to whichever document existed when it started.
A tab opened via `PUT /json/new` is typically still on the pre-navigation document at that moment,
so an in-page wait loop polls a document the SPA never mounts into: it burns its full deadline and
reports the element as missing, which reads exactly like a broken fixture rather than a timing bug.
`verify-cockpit-shell-scroll.ts`'s `waitForShellMounted` and `verify-peek-pane-layout.ts`'s
`pollUntil` are both shaped this way for that reason; copy the shape rather than the convenience.

They exist because the component suite runs under happy-dom, which has **no layout engine**: every
`clientHeight` / `scrollHeight` / `getBoundingClientRect()` reads 0 there, so no geometry assertion
can be written in it. Reach for one of these when the thing you need to prove is a real box-model
property; reach for a component test for anything else. For LOOKING at a rendered cockpit (rather
than asserting on it), use chrome-devtools-mcp per `src/cockpit/CLAUDE.md` §Operator dev loop.

1. **A running cockpit, started WITHOUT `--no-dev-chromium`** — that flag disables exactly the
   dev chromium the script attaches to:

   ```bash
   bun run cockpit:build                      # prod bundle; Vite HMR is unreliable here
   bun src/cli.ts cockpit start --port=3839
   ```

   To verify a change that is not yet on `main`, run both commands from the SESSION workspace and
   point the script at that port — a cockpit started from `main` serves `main`'s build, not yours.

2. **A CDP endpoint at `127.0.0.1:9222`** — the shared dev chromium the cockpit launches
   (`src/cockpit/dev-chromium.ts`). If one is already listening from another cockpit, that one is
   used; the script opens its own tab via `PUT /json/new` and closes it on exit. Check with
   `curl -s localhost:9222/json/version`.

3. **A cockpit auth token at `~/.local/state/minsky/cockpit-token`** — written by the cockpit
   daemon on first start; no manual step. Needed by `verify-conversation-live-tail.ts` (for the
   driven-session API calls) and by `verify-conversation-orientation.ts` (which reads the agents
   widget and a snapshot to find a long enough transcript); `verify-cockpit-shell-scroll.ts` and
   `verify-session-film-panes.ts` make no authed request and do not require it.
   `verify-driven-session-scrollport.ts` reads `GET /api/driven-session` only to pick an id for the
   route, and skips when that list is empty.

`verify-conversation-orientation.ts` additionally needs some ingested conversation longer than 150
turns, which it discovers from the agents widget — `MINSKY_CONVERSATION_ID` names one explicitly.
Unlike its live-tail sibling it spawns no agent and costs no tokens: it only reads an
already-ingested transcript, so it is the cheaper of the two to run.

`verify-conversation-footer-stack.ts` needs a conversation the cockpit currently reports as LIVE or
STALLED — the two presence values under which the activity strip renders at all — and discovers one
from the agents widget, or takes a conversation id as its first argument. It spawns nothing and
mutates nothing, but the state it needs is transient: with no agent working it SKIPs.

`verify-session-film-panes.ts` has one further precondition: at least one filmable conversation,
which it looks up via `GET /api/cockpit/session-film/sessions`. A fresh database has none — that
is a `SKIP`, not a failure. It also prints the served build's `commit` from `/api/health`: on a
machine running several sessions' cockpits at once, the service identity alone cannot tell you
WHICH worktree's build answered.

All of them read the cockpit's identity from **`/api/health`**, not `/health` — the latter falls
through to the SPA's `index.html` and answers 200 with HTML, which would satisfy a bare
reachability check and then fail to parse as JSON. Two of them probed `/health` and asserted no
identity at all until mt#4149 routed every one through the shared preflight.

**A slow target is not a skip.** The preflight separates three answers, because they mean
different things operationally:

| Answer                                | Output                                                      | Exit |
| ------------------------------------- | ----------------------------------------------------------- | ---- |
| nothing is listening                  | `SKIP: no cockpit reachable at …`                           | 0    |
| present, but answered past its budget | `INCOMPLETE: … answered in 20134ms, past its 3000ms budget` | 2    |
| answered, but it is the wrong service | `FAIL: identity FAILED: expected …`                         | 1    |

Before mt#4149 the middle row printed the SAME `SKIP:` line as the first and also exited 0, so a
caller reading the exit code could not tell a performed check from a skipped one. That is not
hypothetical: on 2026-08-13 a cockpit served from a session worktree answered `/api/health`
correctly but took 20.1 s against the 3000 ms budget, and mt#4071's render verification was
reported as a skip.

Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`), `MINSKY_CDP_URL` (default
`http://127.0.0.1:9222`), and the preflight budgets `MINSKY_VERIFY_REACH_TIMEOUT_MS` (3000),
`MINSKY_VERIFY_HEALTH_TIMEOUT_MS` (5000), `MINSKY_VERIFY_SLOW_CONFIRM_TIMEOUT_MS` (30000). Raising
the first two is the designed response to an `INCOMPLETE:` on a legitimately slow target — a
malformed value is rejected rather than silently replaced by the default.

```bash
MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-conversation-live-tail.ts
```

The run SPAWNS a real `claude` process through the cockpit's driven-session API, sends it a prompt
that streams as one long turn, and stops it again on exit — so it costs tokens and takes 30–60s.
That is the point: the defect it checks for (content growing INSIDE an already-rendered turn) does
not exist in a test DOM, which has no height to grow.

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

| Script                                      | Description                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure-adapter-costs.ts`                  | Measures incremental cost of each MCP adapter file after shared commands load.                                                                                                                                                                                                                                      |
| `measure-cold-start.ts`                     | Cold-start measurement: bundle vs raw-source perf delta (mt#1740).                                                                                                                                                                                                                                                  |
| `measure-mcp-start-cold-start.ts`           | Cold-start measurement for the `mcp start` path specifically (mt#1745). Output: `mcp-start-cold-start-results.json`.                                                                                                                                                                                                |
| `measure-source-only.ts`                    | Quick source-path-only cold-start measurement (mt#1792).                                                                                                                                                                                                                                                            |
| `benchmark-mcp-memory-enrichment.ts`        | Latency benchmark for memory-enrichment middleware (mt#1588 spike).                                                                                                                                                                                                                                                 |
| `calibrate-epic-decomposition-staleness.ts` | Calibration script for the mt#1710 Shape C detector against live Postgres.                                                                                                                                                                                                                                          |
| `monitor-reviewer-health.ts`                | Pulls the minsky-reviewer GitHub App's webhook delivery history for health monitoring.                                                                                                                                                                                                                              |
| `audit-unknown-harness-tags.ts`             | Reports harness markup tags absent from `HARNESS_MARKUP_TAGS`, over the local transcript corpus (mt#4061). Report-only; `--json`, `--fail-on-unknown`. Exits 0 with a `SKIP:` line when no corpus is present. Always prints the corpus size — see the script header for why a clean report is ambiguous without it. |
| `mcp-start-cold-start-results.json`         | Output data from `measure-mcp-start-cold-start.ts` (not a script).                                                                                                                                                                                                                                                  |

## Historical research (not code)

| File              | Description                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poc-findings.md` | mt#216 PoC findings memo: running Minsky outside Claude Code. The PoC's driver script (`poc-agent-loop.ts`) was removed as dead code (mt#2610); this findings memo remains as the standalone research artifact it documents. |

## lib/

Shared utilities used by scripts above.

| Module                    | Description                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/pem-utils.ts`        | PEM key parsing/formatting helpers.                                                                                                                                                |
| `lib/verify-preflight.ts` | Shared preflight for the browser-driving `verify-*.ts` scripts (mt#4149): reachability, health-body read, service-identity assertion, and the ABSENT / SLOW / WRONG-SERVICE split. |

## supabase/

Supabase Management API helpers.

| Script                        | Description                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/restart-project.ts` | Self-serve Supabase project restart via Management API (`POST /v1/projects/{ref}/restart`). Dry-run by default; pass `--execute` to actually restart. Required to reset the Supavisor auth-failure circuit breaker — a fast DB reboot alone is NOT sufficient. See mt#2574 and `docs/incidents/2026-06-28-supabase-connectivity-breaker.md`. |
