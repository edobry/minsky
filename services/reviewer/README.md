# minsky-reviewer

Standalone Railway-deployed webhook service that posts adversarial PR reviews as a separate GitHub App identity. Implements the Chinese-wall review architecture described in the [Structural Review position paper](https://www.notion.so/34a937f03cb481b38babf9b676f2f168).

Part of Sprint A (mt#1083) under mt#1073.

## Architecture

```
GitHub PR opened / synchronized
    ↓ webhook (signed)
Railway-hosted service (stateless, this package)
    ├─ Verify webhook signature (X-Hub-Signature-256)
    ├─ Fetch PR diff + task spec (reviewer App token)
    ├─ Tier check (skip Tier 1, gate Tier 2, require Tier 3)
    ├─ Run adversarial review prompt on different-provider model
    └─ Post review as minsky-reviewer[bot]
```

**Levers engaged in v1:** context isolation, capability asymmetry, adversarial prompting, identity separation, model diversity (5/9).
**Deferred to Sprint B:** role specialization, ensemble voting.
**Deferred to Sprint C:** temporal separation, structural incentives.

## Setup (one-time)

1. Create the `minsky-reviewer` GitHub App manually at `github.com/settings/apps/new` with these permissions:
   - `pull-requests: write` — submit reviews
   - `contents: read` — fetch PR files and codebase
   - `metadata: read` — default
   - **No write permissions beyond pull-request reviews.** Capability asymmetry is structural.
2. Install the App on `edobry/minsky`
3. Save credentials to the repo deployment environment:
   - `MINSKY_REVIEWER_APP_ID` — numeric App ID
   - `MINSKY_REVIEWER_PRIVATE_KEY` — PEM contents (Railway variable, multi-line)
   - `MINSKY_REVIEWER_INSTALLATION_ID` — numeric installation ID
   - `MINSKY_REVIEWER_WEBHOOK_SECRET` — webhook shared secret (generate with `openssl rand -hex 32`)
4. Pick a reviewer model provider:
   - `REVIEWER_PROVIDER=openai` + `OPENAI_API_KEY` (recommended, GPT-5)
   - `REVIEWER_PROVIDER=google` + `GOOGLE_AI_API_KEY` (Gemini 2.5 Pro)
   - `REVIEWER_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (fallback only — same family as implementer, captures context-isolation benefit only; the service will log a degraded-config warning at startup when this is selected)
5. Deploy to Railway (see `DEPLOY.md`)
6. Register webhook in the `minsky-reviewer` App settings:
   - URL: `https://<railway-service>.up.railway.app/webhook`
   - Events: `Pull request`, `Pull request review`, `Issue comments`
   - Secret: the same secret as `MINSKY_REVIEWER_WEBHOOK_SECRET`

## Local development

```
bun install
bun run dev   # runs on localhost:3000 with smee.io webhook forwarding
```

## Tests

The reviewer's unit suite lives in `services/reviewer/src/*.test.ts` (~1235
tests). It is hermetic — no live GitHub/model credentials required — and runs
via this service's own `test` script:

```bash
# From services/reviewer/ — this service has its own node_modules
bun install
bun run test          # = bun test --preload ../../tests/setup.ts
```

Or from the repo root (single canonical invocation):

```bash
bun run test:reviewer  # = cd services/reviewer && bun run test
```

**CI status (mt#2367).** This suite runs on every PR as the
`Test (services/reviewer)` step in `.github/workflows/ci.yml`'s required
`build` job — a failing reviewer unit test fails the required check and blocks
merge. Before mt#2367 only the reviewer _typecheck_ ran in CI, so reviewer test
regressions merged undetected (mt#2346 / mt#2350 each shipped 4 red `/retrigger`
tests). The root `bun run test` deliberately scopes its paths and does **not**
include `services/reviewer`, so this dedicated step is what gates the suite.

This is distinct from the **live harness scripts** under `scripts/`
(`seeded-bug-harness.ts`, `reviewer-benchmark.ts`, and the read-only
`verify-diff-scope-subset.ts` — see [Diff-scope subset probe](#diff-scope-subset-probe-mt3663))
which must NOT run in CI —
see [Re-running the harness](#re-running-the-harness-mt1515) → Notes. Those
consume real GitHub quota and create real PRs; the unit suite does neither.

## Tier activation

Reviewer runs on Tier 3 PRs (agent-authored) mandatory, Tier 2 (co-authored) opt-in via `MINSKY_REVIEWER_TIER2_ENABLED=true`, Tier 1 (human-authored) never.

**Sprint A tier source:** the PR body contains an HTML comment of the form `<!-- minsky:tier=N -->` where N is 1, 2, or 3. Implementer code (session_pr_create) should write this marker when provenance is known. If no marker is present, the reviewer defaults to Tier-2 behavior (skip unless tier-2 is explicitly enabled).

**Sprint B/C:** switch to reading Minsky's provenance record directly via Minsky MCP — eliminates the marker-forgetting failure mode.

## Tool access (mt#1126)

The reviewer exposes two read-only tools to the model during review so it can verify cross-file claims before reporting them as findings:

| Tool                   | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `read_file(path)`      | Read a file at the PR's HEAD ref.                            |
| `list_directory(path)` | List immediate children of a directory at the PR's HEAD ref. |

Both tools return a JSON envelope — see **Tool result envelope** below for the full schema (success/failure branches, `truncated`, `binary`, `not_found` sentinel).

Both tools use the `contents: read` permission the App already holds.

**Provider support (MVP):** OpenAI only. The reviewer runs a multi-turn completion loop — when the model returns tool calls, they are executed and results appended as messages, then the model is called again. Gemini and Anthropic fall back to the single-turn no-tools path and the service logs a warning (`[mt#1126/mt#1216] Running review without tools: …`) so operators can see why tool verification is absent.

**Tool gating (two axes):**

- **Provider capability.** Tools are only wired into the call when `REVIEWER_PROVIDER=openai`. Other providers receive the no-tools system prompt, which explicitly tells the model to mark cross-file claims as `NEEDS VERIFICATION` instead of `BLOCKING`.
- **Fork accessibility.** The App is installed on the base repo; it may not have read access to forks. For forked PRs the service runs a lightweight fork-access probe at review start — one `read_file` for `README.md`, falling back to `package.json`. If either resolves, tools are enabled on the fork; if both 403/404, tools are disabled and the no-tools prompt is used to avoid silent failures from tool calls the App can't complete.

**Iteration cap:** The loop runs at most 10 rounds. If the cap is hit, the model is given one final turn to produce a text response; if no text is produced, the review body contains a `[TOOL CAP REACHED]` notice. Because that final turn is passed no tools, only 9 rounds can carry a tool call — and `conclude_review` is a tool call, so it must be emitted by round 9 or a post-loop forced pass has to extract the verdict.

**Round budget signal (mt#3547):** After each round's tool results, the loop appends a `[TOOL BUDGET]` user message stating how many tool-capable rounds remain, escalating to explicit wrap-up guidance with two left. It is append-only — no earlier message is rewritten — so the OpenAI prompt-cache prefix stays valid. Its counterpart in the prompt is the "Your tool budget" section (tools-available path only), which grants explicit permission to conclude before the cap and requires any uncovered surface to be named in the `conclude_review` summary rather than passed over silently. Round count and whether the model concluded in-loop are surfaced on `ReviewOutput.toolLoop`; `services/reviewer/scripts/replay-round-budget.ts` replays PRs and reports them, with `--compare` for a before/after table.

**Behavioral contract:** The `buildCriticConstitution(toolsAvailable)` helper emits one of two system-prompt sections. When tools are available, the prompt instructs the model to call `read_file` / `list_directory` before making cross-file claims and to mark unverified claims `[NON-BLOCKING] NEEDS VERIFICATION`. When tools are NOT available (non-OpenAI provider or forked PR where the access probe failed), the prompt explicitly tells the model no tools are wired up and that all cross-file claims MUST be marked non-blocking with `NEEDS VERIFICATION` — never blocking.

**Verification-mode preamble (mt#1656 / mt#1640 Fix 1):** `buildCriticConstitution` accepts a fourth parameter `priorReviewsPresent: boolean = false`. When the reviewer-worker detects that prior bot reviews already exist on this PR (R≥2 review), it passes `priorReviewsPresent=true`, which swaps the standard adversarial preamble for a verification-mode preamble. The verification preamble reframes the task from unbounded adversarial discovery to bounded verification of the prior round's fixes: new BLOCKING findings are legitimate only when (a) introduced by the fix commit itself, or (b) a critical correctness/security/data-loss issue R1 missed. Otherwise the event verdict defaults to APPROVE. The reframe targets the no-stopping-rule structural problem (mt#1640): the standard preamble's "find SOMETHING every round" framing is correct for R1 but produces bikeshedding at R8+ when the diff has shrunk and substantive issues are addressed. R1 reviews always use the standard preamble (the default is `false`). Empirical validation runs post-merge via the existing `replay-severity.ts` and `measure-calibration.ts` corpus-replay tooling against historical multi-round PRs (mt#1465, mt#1309).

**Path normalization (`normalizeContentPath`):** User-supplied paths are normalized before calling the Contents API: `.`, `./`, `/`, and empty all map to `""` (repo root); leading `./` is stripped; leading slashes (e.g. `/src/foo.ts` → `src/foo.ts`) are stripped; trailing slashes are stripped. This absorbs common LLM path conventions that would otherwise produce spurious 404s.

**Tool result envelope:** Every tool call returns a JSON envelope so the model can disambiguate success/failure and parse structured metadata:

- `read_file` on a text file → `{"ok": true, "content": string, "truncated": boolean}`. `truncated: true` means GitHub's Contents API returned only a partial snippet (files above ~1MB); the prompt tells the model to mark any claim about the full contents as `NEEDS VERIFICATION`.
- `read_file` on a binary file → `{"ok": true, "content": "[BINARY FILE: N bytes, not decoded]", "truncated": boolean, "binary": true, "size": N}`. Binary files are detected by a NUL byte in the first 8KB (the `file(1)` heuristic); they are not decoded as UTF-8 because doing so would burn context on gibberish. `size` is the authoritative repository-stored file size reported by the GitHub Contents API (not the bytes fetched). `truncated: true` indicates the binary exceeded the API's ~1MB threshold (rare in practice since we never decode the snippet anyway, but surfaced for completeness).
- `read_file` on a missing file → `{"ok": false, "error": "not_found"}`.
- `list_directory` on a directory → `{"ok": true, "entries": [{"name", "type"}, …]}` where `type` is one of `file`, `dir`, `symlink`, or `submodule`. The four types are passed through so the model can see symlinked configs and submodule references accurately.
- Unexpected errors on either tool → `{"ok": false, "error": "<message>"}`.

The envelope structurally disambiguates "missing file" from "file whose content happens to be the literal string `null`" — a failure mode of the earlier raw-string protocol.

## Comment commands

The bot recognizes the following comment commands. Each must be the **entire first line** of the comment (whitespace-trimmed) — inline usage like `some text /review` is ignored.

| Command              | Effect                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `/review` (mt#2127)  | Trigger a fresh review on the PR's current HEAD                                                |
| `/resolve` (mt#2173) | Resolve all unresolved bot-authored review threads and dismiss stale CHANGES_REQUESTED reviews |

Shared guards (apply to all commands):

- Only fires on comments attached to a PR (not plain issues)
- Only fires on **open**, non-draft PRs
- Only fires for collaborators (`COLLABORATOR`, `MEMBER`, or `OWNER` author association)

### `/review`

Triggers a fresh review on the PR's current HEAD. Duplicate prevention: `runReview` acquires an inflight marker (mt#1907) keyed on PR + HEAD SHA, so rapid repeated `/review` comments coalesce at the review layer.

### `/resolve`

Resolves all unresolved bot-authored review threads (via GraphQL `resolveReviewThread`) and dismisses bot-authored CHANGES_REQUESTED reviews (via REST `pulls.dismissReview`) so they no longer block the merge gate. Useful once the PR author has addressed findings and wants to clear the bot's outstanding state without waiting for a fresh review. Each operation is best-effort — a single failure logs but doesn't abort the rest. The status comment is updated with the resolve/dismiss counts.

### Programmatic retrigger

The service exposes `POST /retrigger` for agent-driven retriggers. It is
authenticated with the **Minsky MCP auth token** (`MINSKY_MCP_AUTH_TOKEN`) —
the operator->service credential operators already hold for the hosted Minsky
MCP endpoint, and which the reviewer service already has — **not** the webhook
HMAC secret (mt#2346). Operators therefore never need to obtain or store the
reviewer's webhook signing secret locally; that secret is sealed on the
reviewer service and used only for GitHub->reviewer webhook signature
verification.

```bash
curl -X POST https://<service>/retrigger \
  -H "Authorization: Bearer $MINSKY_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pr": 42, "owner": "edobry", "repo": "minsky"}'
```

All three fields (`pr`, `owner`, `repo`) are required. Returns JSON `{ ok, pr, deliveryId }` on success, `{ error }` on failure. Returns `503` if the service itself has no `MINSKY_MCP_AUTH_TOKEN` configured (fail-closed), `401` on a wrong/missing token.

The equivalent MCP command is `reviewer.retrigger`:

```
minsky reviewer retrigger --pr 42 --owner edobry --repo minsky
```

Resolves its target URL from `reviewer.url` (env override `MINSKY_REVIEWER_URL`,
hosted default otherwise) and its auth token from `mcp.auth.token` (env override
`MINSKY_MCP_AUTH_TOKEN`) through the standard Minsky config system.

## PR status comment (mt#2131)

The reviewer bot maintains a persistent status comment on each PR that updates through the review lifecycle. The comment is identified by a hidden HTML marker (`<!-- minsky-reviewer-status -->`) and is updated in-place across review rounds.

### Lifecycle states

| State           | When                                   | Example                                                            |
| --------------- | -------------------------------------- | ------------------------------------------------------------------ |
| **Pending**     | Webhook received, before review starts | "Review requested — awaiting processing"                           |
| **In progress** | Review worker started                  | "Review in progress..."                                            |
| **Completed**   | Review posted                          | Verdict, finding count, review link, model/token/duration metadata |
| **Error**       | Review failed                          | Generic error message with `/review` retry hint                    |
| **Skipped**     | Routing decided to skip                | Sanitized skip reason (e.g., tier routing)                         |

### Completed state format

```
## Minsky Reviewer Status

**Verdict:** CHANGES_REQUESTED — 2 blocking finding(s)
**Review:** [View review](#pullrequestreview-12345)
**Model:** openai/gpt-5 | **Tokens:** 95K prompt, 4K completion | **Duration:** 47s
**Mode:** standard

### Commands
- `/review` — request a fresh review
```

### Persistence

The status comment uses a marker-based approach — no database migration required. On each update, the bot searches its own comments for the `<!-- minsky-reviewer-status -->` marker (paginating through up to 1000 comments). If found, the existing comment is updated in-place; otherwise a new comment is created.

### Error sanitization

Error and skip reasons are sanitized before posting to the PR. Only recognized safe patterns (tier routing, timeout, draft skip) pass through; unrecognized errors show a generic "an internal error occurred" message. Detailed errors remain in the service logs.

### Draft PRs

Draft PRs are skipped at all entry points — webhook handler, `/review` comment command, and `/retrigger` endpoint. No status comment is created for draft PRs.

## In-flight marker: the current acquisition contract (mt#4267)

Concurrent review attempts for the same `(owner, repo, pr_number, head_sha)` arbitrate through a
row in `reviewer_inflight_reviews`. **The current mechanism is a conditional takeover:**

```sql
INSERT INTO reviewer_inflight_reviews (...)
VALUES (...)
ON CONFLICT (owner, repo, pr_number, head_sha) DO UPDATE
   SET acquired_by = EXCLUDED.acquired_by, delivery_id = EXCLUDED.delivery_id,
       acquired_at = EXCLUDED.acquired_at, expires_at  = EXCLUDED.expires_at
 WHERE reviewer_inflight_reviews.expires_at < now()
RETURNING id
```

- A **live** row fails the `WHERE`, so nothing is updated and `RETURNING` is empty — the caller is
  refused, exactly as before (mt#1907 AT-4/AT-5).
- An **expired** row is taken over in the same statement, keeping its id.

**Read this rather than the migration header.** `migrations/pg/0002_inflight_reviews.sql` describes
the original mt#1907 shape, `ON CONFLICT ... DO NOTHING`, and that comment is left alone as the
historical record of what that migration shipped — a migration is applied once and its text is not
a live contract. The current contract is this section plus the module docblock in
`src/inflight-marker.ts`.

Expiry is enforced at **two** points, and both are load-bearing: acquire-time (above) makes a
marker orphaned by a killed process recoverable by the next caller, whichever entry point that is;
`pruneStaleMarkers`, run by the sweeper at the top of each cycle, reclaims rows for PRs nobody
retriggers. Before mt#4267 only the second existed, so a marker orphaned by a redeploy refused
every direct `/retrigger` until a sweeper cycle happened to sweep it — up to `SWEEPER_INTERVAL_MS`
(default 10 min) away, and invisible to the caller.

## Re-running the harness (mt#1515)

Two scripts under `services/reviewer/scripts/` codify the acceptance tests for the reviewer service fidelity and latency:

| Script                  | Purpose                                                                                                                                             | Output                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `seeded-bug-harness.ts` | Fidelity: creates a real PR with a deliberate known-location bug, asserts the reviewer catches it with `CHANGES_REQUESTED` and a file:line citation | `scripts/seeded-bug-results.json`         |
| `reviewer-benchmark.ts` | Latency: measures end-to-end wall time for recent Tier-3 PRs                                                                                        | `scripts/reviewer-benchmark-results.json` |

### Prerequisites

```
bun install   # run from services/reviewer/ — this service has its own node_modules
```

### Required environment variables

| Variable       | Required by          | Notes                                                                                                                               |
| -------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | Both scripts         | PAT or App-installation token. Harness needs `repo` write scope (branch + PR create/close/delete). Benchmark needs read-only scope. |
| `OWNER`        | Both (optional)      | GitHub owner. Defaults to `edobry`.                                                                                                 |
| `REPO`         | Both (optional)      | GitHub repository. Defaults to `minsky`.                                                                                            |
| `BASE_BRANCH`  | Harness (optional)   | Base branch for the seeded-bug PR. Defaults to `main`.                                                                              |
| `LIMIT`        | Benchmark (optional) | Number of Tier-3 samples to collect. Defaults to `3`.                                                                               |

### Running the harness

```bash
# From services/reviewer/
GITHUB_TOKEN=<your-token> bun scripts/seeded-bug-harness.ts
```

The harness creates a branch, opens a PR, polls for a `minsky-reviewer[bot]` review (up to 5 min), asserts the finding, writes results, then closes the PR and deletes the branch. Exit code 0 = passed, 1 = failed or timed out.

### Running the benchmark

```bash
# From services/reviewer/
GITHUB_TOKEN=<your-token> bun scripts/reviewer-benchmark.ts
```

The benchmark lists recent merged PRs, identifies Tier-3 ones by body marker or reviewer presence, computes latency from last commit time to first bot review, and writes structured stats. Exit code 0 = collected at least `LIMIT` samples, 1 = insufficient samples.

### Notes

- **Do not add these scripts to CI.** They consume real GitHub API quota, create real PRs (harness), and require live credentials. Run manually for baseline collection.
- The seeded-bug target directory (`scripts/__seeded_bug_targets__/`) is gitignored locally. Harness runs write files there but do not commit them; the remote branch is deleted by the harness in its cleanup step.
- Results files (`seeded-bug-results.json`, `reviewer-benchmark-results.json`) are written locally in the `scripts/` directory. Commit them manually if you want to checkpoint a baseline.

## Diff-scope subset probe (mt#3663)

`scripts/verify-diff-scope-subset.ts` is a live, operator-run probe for the invariant that a
narrowed review scope never leaves the PR's own merge-base diff. It runs the **production**
`resolveDiffScope` against the **real** GitHub responses for PR #2587 — the incident that
produced mt#3663, where a merge-from-main commit in the compare range turned a 6-file PR into a
157-file review surface and produced BLOCKING findings against four files the PR never touched.

**Do not add this script to CI.** Like the harness scripts above it consumes real GitHub API
quota and needs live credentials. It is read-only (no PRs created, no writes of any kind), which
makes it cheaper and safer than the harness — but "safe to run" is not "should run
automatically."

| Env var                      | Required | Purpose                                                               |
| ---------------------------- | -------- | --------------------------------------------------------------------- |
| `VERIFY_DIFF_SCOPE_RUN_LIVE` | yes      | Must be exactly `true`. Affirmative opt-in; checked BEFORE the token. |
| `GITHUB_TOKEN`               | yes      | Read-only scope is sufficient.                                        |

The opt-in is checked first **on purpose**: every GitHub Actions job carries a `GITHUB_TOKEN`, so
gating on the credential alone would let a future workflow pick this script up and spend API
calls without anyone choosing to. With the opt-in absent it exits 0 and prints a SKIP naming the
switch.

```bash
# From the repo root
VERIFY_DIFF_SCOPE_RUN_LIVE=true GITHUB_TOKEN=$(gh auth token) \
  bun services/reviewer/scripts/verify-diff-scope-subset.ts
```

Exit 0 with `"status": "PASS"` means both cases held; exit 1 prints a `failures` array naming the
case and check that broke.

**Why the repo/PR coordinates are pinned rather than env-parameterized.** The script's assertions
are _about this incident_: it checks that the compare range still contains four specific paths the
reviewer falsely flagged, that the range's merge base still equals its base, and that case A
resolves to the full-diff fallback while case B narrows to exactly one file. Those expectations
are meaningless against a different PR, so pointing the script elsewhere would not generalize it —
it would just make it fail. Treat the pinned SHAs as part of the fixture, not as configuration.

## Operator alerts (mt#2364 / mt#1596)

When the submission-failure circuit breaker (mt#2350) trips — a PR's review submission keeps failing with a non-retryable error and the sweeper has stopped retriggering it — the failure is surfaced two ways:

1. **On-cockpit (Phase 1, mt#2363, always on):** an operator-routed `coordination.notify` Ask is created and rendered on the cockpit `AsksPage`.
2. **Off-cockpit (Phase 2, mt#2364, opt-in):** an external alert sink pushes the same failure to a channel that reaches you when the cockpit isn't open (after-hours, weekend, mobile).

The external sink is **disabled by default**. It fails open — a sink error never crashes the sweep, and never affects the circuit-breaker dedup (which is gated on the cockpit-Ask outcome).

### Telegram (recommended) — Pulumi-native setup (mt#2419)

The reviewer's env vars are owned by Pulumi (`infra/index.ts`); do NOT hand-edit them in the
Railway dashboard (drift). The setup flow keeps the token out of chat, shell history, and the
repo (it lives passphrase-encrypted in the gitignored `infra/Pulumi.prod.yaml`):

1. **Create the bot:** message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
   prompts, copy the token. Then **send your new bot any message** (required: Telegram only
   exposes a chat id after the user has messaged the bot — there is no lookup API).
2. **Store the token (masked prompt — value omitted on purpose):**

   ```bash
   pulumi -C infra config set --secret secrets:minsky-reviewer-telegram-bot-token
   ```

3. **Discover your chat id** (reads the token internally; prints only the id):

   ```bash
   bun scripts/reviewer-alerts/discover-chat-id.ts
   ```

4. **Enable on the stack** (per-stack opt-in — the chat id and enablement live in the
   gitignored `Pulumi.<stack>.yaml`, never in the shared IaC):

   ```bash
   pulumi -C infra config set reviewer-telegram-chat-id <discovered id>
   ```

   `infra/index.ts` declares `ALERT_SINK_TYPE` / `TELEGRAM_CHAT_ID` /
   `TELEGRAM_BOT_TOKEN` only when that config value is present. Then `pulumi up` from `infra/`.

5. **Verify** (sends one real message; PASS only on a 2xx from Telegram):

   ```bash
   bun scripts/reviewer-alerts/verify-send.ts <chat-id>
   ```

The Telegram sink posts via the Bot API `sendMessage` endpoint with a raw `fetch` — no SDK dependency. A future `MatrixAlertSink` (mt#1454) will drop in behind the same `AlertSink` interface.

#### Fallback: manual env vars (non-Pulumi deployments only)

```bash
ALERT_SINK_TYPE=telegram
TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
TELEGRAM_CHAT_ID=<your chat id>
```

Only for deployments whose env is not IaC-managed — on the Minsky production reviewer these
would be clobbered by the next `pulumi up`.

### Generic webhook

```bash
ALERT_SINK_TYPE=webhook
ALERT_SINK_URL=https://your-endpoint.example/alerts
ALERT_SINK_SECRET=<optional shared secret>   # sent as the x-alert-secret header
```

POSTs `{ severity, title, body }` as JSON.

### Verify the wiring

```bash
ALERT_SINK_TYPE=telegram TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
  bun services/reviewer/scripts/smoke-alert-sink.ts
```

Sends one test message through the configured sink (SKIPs gracefully when no sink is configured).

### Verify the DEPLOYED path (`POST /alert-test`, mt#2451)

`smoke-alert-sink.ts` above proves the sink works from **your laptop's** env. To prove the
**deployed** path — the service's own env config → its sink instance → Telegram → your phone —
without waiting for a real circuit-breaker trip, hit the authenticated `/alert-test` endpoint.
It calls the SAME sink instance the sweeper uses:

```bash
curl -X POST https://<service>/alert-test \
  -H "authorization: Bearer $MINSKY_MCP_AUTH_TOKEN"
```

Auth is the MCP auth token (`MINSKY_MCP_AUTH_TOKEN`), same as `/retrigger`. Responses:

- **200** `{ ok: true, sinkType, deliveryAttempted: true }` — the send path was invoked and
  accepted. Sinks are fail-open (`notify` never throws), so a 200 means "accepted by the sink
  path"; **confirm actual receipt on your phone**.
- **401** — missing or wrong bearer token.
- **503** `{ error: "alert-test auth not configured" }` — `MINSKY_MCP_AUTH_TOKEN` is unset on
  the service.
- **503** `{ error: "no alert sink configured", hint }` — `ALERT_SINK_TYPE` is unset/off (the
  hint names the env vars to set).

## Self-hosting

The service is deliberately stateless. Any deployment target that supports Node.js webhooks works (Railway, Fly, Vercel Functions, Render). Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely.

## Troubleshooting

### Review-scope feature flags

- `REVIEWER_INCREMENTAL_DIFF_ENABLED` (mt#3471, **on** in production) — on a re-review round
  (R>=2), show the model only the commits pushed since the last posted review instead of the whole
  PR diff again. The prior review's findings stay in the prompt and the file-reading tools still
  resolve at HEAD, so the round can still verify its own earlier BLOCKING findings. The base is the
  prior review's `commit_id`, so a force-push that orphans it produces a 404 rather than a
  silently-wrong range; that and any truncated or 5xx comparison fall back to the full diff
  (`reviewer.incremental_diff_fallback_full`). Turning it off restores full-diff-every-round at the
  original cost.
- `REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED` (mt#1875, **off**) — separate and quality-affecting:
  additionally DOWNGRADES a BLOCKING finding to NON-BLOCKING when its file:line falls outside the
  reviewed scope. Independent of the flag above by design, so the cost lever can run without
  changing what the reviewer blocks on. When both are on, the downgrade pass bounds itself to the
  same narrowed diff the model was shown.

### Network-call timeouts (mt#1086)

Outbound model and GitHub API calls are wrapped with `AbortController` timeouts. Without timeouts, a hung outbound call holds the worker open until the platform kills it (~30-60s on Railway, longer elsewhere); with them, you see the failure in service logs immediately and the sweeper (mt#1260) re-triggers the review on its next pass.

**Defaults and production latency (calibrated 2026-05-24):**

- `REVIEWER_MODEL_TIMEOUT_MS=120000` — model API calls (OpenAI / Anthropic / Google). 120s per tool-loop round. Successful reviews complete in 50-60s. Transient timeouts (provider-side latency spikes) are recovered by `callToolloopWithRetry` in 10-20s; a second retry layer in `callReviewerWithRetry` catches any that propagate (mt#2083).
- `REVIEWER_TOOLLOOP_RETRY_TIMEOUT_MS=120000` — retry ceiling when a tool-loop round times out. Matches the primary timeout. Tunable at call time without redeploy.
- `REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT=true` — enable/disable the per-round timeout retry. Default `"true"`.
- `REVIEWER_GITHUB_TIMEOUT_MS=30000` — GitHub REST and GraphQL calls. 30s is generous; happy-path GitHub calls return in <5s. Lower it if you want to surface GitHub-side latency faster.

**Timeout incident analysis (mt#2083, 2026-05-24):** PR #1252 (1-line bunfig.toml change) showed two timeout events on the webhook path. Initial diagnosis attributed this to insufficient timeout budget for trivial PRs. Production log analysis revealed both timeouts recovered via the existing per-round retry (`callToolloopWithRetry`) in 10-20 seconds — reviews posted successfully at 17:37:14 and 17:40:15. The sweeper at 17:41:12 caught a separate webhook-miss (mt#1372 class), not a timeout failure. An initial scope-aware tool-loop bypass (skipping tools for trivial PRs) was shipped and then reverted as a net-negative quality tradeoff. The retry timeout was raised from 90s to 120s and an outer `TimeoutError` catch was added as defense-in-depth. Per-review timing persistence (mt#2088) was filed to make future analyses queryable without Railway log access.

**Validation:** timeout env vars must parse as positive integers. `0`, negative numbers, decimals, non-numeric strings, and whitespace-padded values are rejected at boot with a clear error pointing at the env var name. The reviewer will not start with malformed timeout config — by design, since silent NaN coercion would produce infinite waits, defeating the point.

**Observing timeouts:** when a call exceeds its budget, a structured-shape JSON log is emitted to stderr with `event: "timeout"`, the operation name (e.g. `openai.chat.completions.create.toolloop`, `github.pulls.listFiles`), the configured `timeoutMs`, and elapsed `durationMs`. Then a typed `TimeoutError` propagates through `runReview` where `callReviewerWithRetry` retries once (mt#2083). If the retry also fails, the error is caught by the detached-review handler in `server.ts` and logged as `review_error`. The webhook returns 200 immediately on receipt regardless (ack-immediate per mt#1191); the sweeper (mt#1260) catches missed reviews on its next pass, so GitHub-level retry is not required here.

**Tuning advice:** start with the defaults. If model timeouts fire on legitimate review activity, the right move is usually to lower `reasoning_effort` rather than to raise the timeout — a model that needs >2 min on a Tier-3 PR is usually exhausting reasoning budget without producing useful output. If GitHub timeouts fire, check that the reviewer App's installation token is current and that you aren't rate-limited.
