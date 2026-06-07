# Claude Code Hooks: Behavioral Specification

## System Overview

Six TypeScript hooks (in `.claude/hooks/`) forming two subsystems:

1. **Typecheck subsystem** (3 files, shared state): informational feedback on edit, blocking gate on stop
2. **Workflow subsystem** (3 files, independent): review gate, auto-pull, remote bootstrap

All hooks share types and a sync exec helper from `types.ts`. They are self-contained — no imports from `src/` — so they work even when the main codebase has type errors.

Additional standalone hooks beyond the original two subsystems (e.g.,
`transcript-ingest-on-session-end.ts`) are documented in their own sections
below; the guard/detector hooks live in `.minsky/rules/hook-files.mdc`.

## `session-start.ts`

### Interface

- **Event**: SessionStart
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_CODE_REMOTE`, `CLAUDE_PROJECT_DIR`
- **Output**: None (side effects only)
- **Exit code**: 0

### Behavior

1. Guard: exits immediately if `CLAUDE_CODE_REMOTE` is not `"true"` (local sessions skip entirely)
2. If `node_modules/` or `node_modules/winston/` is missing, runs `bun install`
3. If `gitleaks` is not in PATH, downloads v8.21.2 linux_x64 binary from GitHub releases to `/usr/local/bin/gitleaks`

### Edge cases

- Hardcodes gitleaks version `8.21.2` and architecture `linux_x64`
- Assumes `/usr/local/bin/` is writable (container environment)

---

## `typecheck-on-edit.ts`

### Interface

- **Event**: PostToolUse (Write, Edit, session_write_file, session_edit_file, session_search_replace)
- **Input (stdin JSON)**: `tool_input.file_path`, `tool_input.path`, `tool_result.filePath`, `session_id`, `agent_id`
- **Output (stdout JSON)**: `hookSpecificOutput` with `additionalContext` on type errors
- **Exit code**: Always 0 (informational only, never blocks)
- **Timeout**: 30s

### Behavior

1. Reads stdin JSON via `Bun.stdin.json()`
2. Extracts file path from `tool_input.file_path`, falling back to `tool_input.path`, then `tool_result.filePath`
3. Exits silently if file is not `.ts` or `.tsx`
4. **Session-aware root detection**: if file path starts with `$HOME/.local/state/minsky/sessions/`, extracts session root; otherwise uses `$CLAUDE_PROJECT_DIR`
5. **State tracking**: appends `project_root` to `/tmp/claude-typecheck-roots-${session_id}-${agent_id}.txt` (or `-main.txt` if no agent_id)
6. Runs `bunx @typescript/native-preview --noEmit` (tsgo) in the project root
7. On tsgo failure, filters errors into two categories:
   - **File errors**: lines starting with `${relative_path}(` — errors in the edited file
   - **Cascade errors**: remaining errors in other files
8. Outputs structured JSON with error preview (first 10 lines of file errors) and cascade count

### Output format (on errors in edited file)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "TypeScript errors in edited file:\n<errors>\n(+ N cascade error(s) in other files)"
  }
}
```

### Output format (cascade-only errors)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "TypeScript: N error(s) in other files (cascade from ongoing edits, checked at turn end)"
  }
}
```

### Shared state written

- Appends to: `/tmp/claude-typecheck-roots-${session_id}-${agent_id|main}.txt`

---

## `typecheck-on-stop.ts`

Handles both **Stop** and **SubagentStop** events. Determines which state file to read based on `agent_id` from the input JSON.

### Interface

- **Event**: Stop, SubagentStop
- **Input (stdin JSON)**: `session_id`, `agent_id`, `hook_event_name`, `cwd`
- **Output (stdout JSON)**: `hookSpecificOutput` with error details on failure
- **Exit code**: 0 (pass) or 2 (fail — forces Claude to continue)
- **Timeout**: 60s

### Behavior

1. Reads stdin JSON, determines state file path from `session_id` and `agent_id`
2. Reads unique project roots from state file (deduplication via `Set`)
3. Falls back to `cwd` then `CLAUDE_PROJECT_DIR` if no state file
4. For each root:
   - Skips if directory doesn't exist
   - Skips if no `tsconfig.json`
   - Runs `bunx @typescript/native-preview --noEmit` (tsgo, full check) and captures output
   - Counts errors matching `): error TS`
   - Collects errors with `=== ${root} ===` header
5. If any root failed: outputs JSON with first 60 lines of errors + total count, exits 2
6. If all passed: deletes state file, exits 0

### Output format (on failure)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop|SubagentStop",
    "additionalContext": "TypeScript errors must be fixed before completing:\n<first 60 lines>\n\nTotal: N error(s). Fix all type errors before returning."
  }
}
```

### Critical: exit 2 semantics

Exit code 2 is a **blocking error** in Claude Code — the agent is forced to continue and fix the errors. This is the correctness gate.

---

## `require-review-before-merge.ts`

### Interface

- **Event**: PreToolUse (mcp**minsky**session_pr_merge)
- **Input (stdin JSON)**: `tool_input.task`
- **Output (stdout JSON)**: `permissionDecision: "deny"` with reason, or nothing (allow)
- **Exit code**: Always 0
- **Timeout**: 15s

### Behavior

1. Extracts `task` from `tool_input` — exits silently if empty
2. Constructs branch name: `task/${task.replace("#", "-")}`
3. Looks up PR number and head SHA via `gh pr list --json number,headRefOid`
4. Exits silently if no PR found
5. Fetches reviews via `gh api repos/.../pulls/<pr>/reviews`
6. **Review presence:** deny if 0 reviews
7. **Spec verification:** deny if no review body matches `/spec[- ]verification/i`
8. **Documentation impact:** deny if no review body matches `/documentation[- ]impact/i`
9. **Review freshness:** of the reviews containing spec verification, the most recent one's `commit_id` must equal the PR HEAD sha; otherwise deny as stale (covers an older commit). Skipped only when the PR-list query did not return a head sha.
10. **CI check_runs presence (mt#1309 webhook-miss regression detection — presence floor):** fetch `gh api repos/.../commits/<headSha>/check-runs?per_page=1` (10s timeout). The `?per_page=1` query keeps the response tiny — the gate only reads `total_count`, which is the canonical pagination-safe field on GitHub's Checks API. The response is run through `parseCheckRunsResponse`, which returns either `{ok:true, count}` or `{ok:false, error}`. `evaluateCheckRunsPresence` then:

    - **deny with API-failure reason** if `{ok:false}` (timeout via `timedOut:true`, non-zero exit, empty body, non-JSON, missing fields, etc.). The reason is distinct from the webhook-miss text — it instructs the operator to investigate the gh api error before retrying. Timeouts get a distinct "gh api timed out" prefix.
    - **deny with webhook-miss reason** if `{ok:true, count:0}`. The reason names mt#1309 / PR #763 lineage and points at the empty-commit-to-wake-the-webhook recovery path documented in `/merge-coordination` step 7a.
    - **allow** if `{ok:true, count>0}`. Status of the runs is intentionally NOT checked here — this gate is the "presence-only, status-agnostic" floor. The mt#1938 gate below adds status enforcement on top.

11. **Bundle-boot smoke check (mt#1787):** fetches `gh api .../commits/<headSha>/check-runs?check_name=bundle-boot-smoke` and runs the response through `parseBundleBootSmokeResponse` + `evaluateBundleBootSmokePresence`. Denies on API failure, missing check_run, in-progress/queued, or any non-success conclusion. Latest-wins recency: a later re-run failure overrides an earlier success. Override env: `MINSKY_SKIP_BUNDLE_SMOKE` (audit-logged).

12. **Required-checks status enforcement (mt#1938 — generalized CI-status enforcement).** This gate closes the agent-driven-merge leg of the main-red coverage holes (originating incident: PR #1163 / mt#1927, 2026-05-19). Operates in two API calls:
    - `gh api repos/edobry/minsky/branches/main/protection` → `parseBranchProtectionResponse` extracts the `required_status_checks.contexts[]` list and `enforce_admins.enabled` flag.
    - `gh api repos/.../commits/<headSha>/check-runs?per_page=100` → `parseAllCheckRunsResponse` extracts every run on the SHA into a flat list.
      `evaluateRequiredChecksStatus` then, for each required check name:
    - Filters runs by name using the same matcher as bundle-boot-smoke (exact OR workflow-prefixed `<workflow> / <jobName>`).
    - Picks the latest run via `pickLatestRunByName` (sorted by completedAt then startedAt, descending — same latest-wins semantics as mt#1787).
    - **Denies** if no matching run exists (the check that was supposed to fire didn't — webhook miss, workflow disabled, or PR predates the contexts list); the denial reason names the `session_commit { noFiles: true, noStage: true }` webhook-wake recovery.
    - **Denies** if the latest run's `status !== "completed"` (queued / in_progress — wait for completion).
    - **Denies** if the latest run's `conclusion !== "success"` (the originating-incident class). The denial reason includes the run's `htmlUrl` for triage.
    - **Allows** when every required check's latest run concluded success.
      If branch protection returns 0 required checks, the gate passes silently — no contract to enforce; the mt#1309 presence floor still applies. `enforceAdmins` is parsed but not acted on here (it's a GitHub-side enforcement field; this gate operates at the Claude Code tool layer). Override env: `MINSKY_SKIP_REQUIRED_CHECKS` (audit-logged).

The check is skipped entirely when `headSha` is unavailable (the `gh pr list` lookup at step 3 returned no row). This is a soft skip — the hook continues to allow the merge based on the prior review/spec/doc/freshness gates that already passed.

### Layered enforcement model (mt#1938)

This hook is one layer of a three-layer enforcement stack — it covers only the Claude Code tool-invocation surface. The other two layers cover paths outside Claude Code's view by construction:

| Layer | Surface covered                                                                           | Mechanism                                                                    |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | Claude Code tool invocations (`mcp__minsky__session_pr_merge`, agent `gh api PUT /merge`) | This hook (`require-review-before-merge.ts`)                                 |
| 2     | Operator-terminal commands, GitHub web UI                                                 | GitHub branch protection (`required_status_checks` + `enforce_admins: true`) |
| 3     | Universal post-merge backstop                                                             | `.github/workflows/main-watch.yml` — opens P0 issue on red main CI           |

Claude Code hooks cannot see operator-terminal shell invocations of `gh api PUT /merge`. The operator-API path that produced the originating incident (PR #1163) is structurally outside this hook's reach; layer 2 (branch protection with `enforce_admins: true`) is the load-bearing fix for that path. Layer 3 catches anything that gets past layers 1 and 2.

### Ordering

The gates run in this fixed order: review presence → spec verification → documentation impact → review freshness → CI check_runs presence → bundle-boot smoke → required-checks status. The most-specific user-actionable failure surfaces first; CI-related gates run last because they query external APIs and represent less-likely-to-recur failure modes. The required-checks status gate (mt#1938) runs after bundle-boot-smoke (mt#1787) because bundle-boot is a stricter, more specific check; if both would fail, the bundle-boot reason is more actionable for the dev-vs-deployed-divergence class.

### Dependencies

- `gh` CLI (GitHub CLI) — must be authenticated
- Hardcodes repo: `edobry/minsky`

### Testable surfaces

The hook body is wrapped in `if (import.meta.main)` so the pure helpers
(`parseCheckRunsResponse`, `evaluateCheckRunsPresence`) can be unit-tested via
import without triggering the stdin-blocking entry point. See
`.claude/hooks/require-review-before-merge.test.ts`.

---

## `post-merge-pull.ts`

### Interface

- **Event**: PostToolUse (session_pr_merge, merge_pull_request)
- **Input**: None used from stdin
- **Env vars**: `CLAUDE_PROJECT_DIR`
- **Output (stdout)**: Plain text warning if MCP server source changed
- **Exit code**: Always 0
- **Timeout**: 20s

### Behavior

1. Records HEAD before pull: `git rev-parse HEAD`
2. Pulls: `git pull --ff-only origin main` (ignores errors)
3. Records HEAD after pull
4. If HEAD changed AND `src/` files were modified in the diff: prints warning about stale MCP server

---

## `transcript-ingest-on-session-end.ts`

### Interface

- **Event**: SessionEnd
- **Input (stdin JSON)**: `session_id`, `cwd`, `hook_event_name`
- **Env vars**: `MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK` (skip the hook),
  `MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED` (opt in to the embedding step),
  `MINSKY_STATE_DIR` (log-dir override)
- **Output**: None as `HookOutput` (side effects only; the override path emits a
  non-JSON audit line to stdout)
- **Exit code**: Always 0 (SessionEnd is a no-decision-control event; the hook must
  never block session teardown)
- **Timeout**: 45s

### Behavior

1. If `MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK` is truthy (`1`/`true`/`yes`), emits a
   non-JSON audit line to stdout and exits 0.
2. Reads stdin JSON; on parse failure, no-op exit 0.
3. If `session_id` is absent, writes a `{skipped: true, reason: "no-session-id"}`
   record to the log and returns.
4. Runs `minsky transcripts ingest --session=<id> --harness=claude_code`
   synchronously (20s budget). The ingest is HWM-gated and incremental, so it is a
   cheap no-op for an already-ingested session. FTS search (`transcripts_search-text`)
   works immediately after a successful ingest; no external API is needed.
5. If ingest succeeded AND `MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED` is truthy, runs
   `minsky transcripts index-embeddings --session=<id>` (20s budget) — best-effort;
   failures are logged, not fatal. Default OFF; the default semantic-embed backfill
   home is mt#2234's cadence sweep.
6. Appends one JSON record per run to `<state-dir>/transcript-ingest-hook-log.jsonl`.

### Observable log record

`<state-dir>` is `$MINSKY_STATE_DIR` or `~/.local/state/minsky`. Each line is one
JSON object (append-only JSONL):

```json
{
  "timestamp": "...",
  "event": "session_end",
  "sessionId": "...",
  "ingest": { "exitCode": 0, "timedOut": false }
}
```

On failure the `ingest` (and `embeddings`, when the embed step is enabled) sub-object
carries the non-zero `exitCode`, `timedOut`, and a truncated `stderr`. The returned
`IngestOutcome` mirrors these signals (`ingestExitCode`, `ingestTimedOut`,
`embeddingsExitCode`, `embeddingsTimedOut`) so a timeout is distinguishable from a
generic failure.

### Reliability boundary

- **Covers** sessions that end normally (the SessionEnd event fires).
- **Does NOT cover** SIGKILL / crash-terminated sessions (the event never fires), nor
  default semantic-embed backfill — both are backstopped by the MCP boot sweep
  (mt#2051) and the cadence sweep (mt#2234).

### Testable surfaces

The core `runTranscriptIngestOnSessionEnd(input, deps)` is pure over injected deps and
unit-tested in `transcript-ingest-on-session-end.test.ts`. The end-to-end CLI→Postgres
path is live-verified by `scripts/smoke-transcript-ingest-hook.ts`.

---

## Behavioral Contract

1. **Exit codes**: edit hook always 0; stop hooks 0 or 2; review hook always 0; merge hook always 0
2. **JSON output schema**: `hookSpecificOutput` structure must match exactly — Claude Code parses it
3. **State file paths**: `/tmp/claude-typecheck-roots-${session_id}-${agent_id|main}.txt` — edit writes, stop reads+deletes
4. **Session root detection**: `$HOME/.local/state/minsky/sessions/<uuid>/` prefix check
5. **tsgo**: `--noEmit` for both edit and stop; edit checks single root (fast feedback), stop checks all tracked roots (correctness gate)
6. **Error filtering**: edit hook separates file-local vs cascade errors; stop hook aggregates all
7. **Review gate**: five gates in fixed order — review presence → spec verification → documentation impact → review freshness (covers HEAD) → CI check_runs presence (mt#1309). API/parse failures on the CI gate produce a distinct deny reason from the webhook-miss case.
8. **Post-merge pull**: ff-only, warns only if src/ changed
