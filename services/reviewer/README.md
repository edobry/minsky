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
   - Events: `Pull request`, `Pull request review`
   - Secret: the same secret as `MINSKY_REVIEWER_WEBHOOK_SECRET`

## Local development

```
bun install
bun run dev   # runs on localhost:3000 with smee.io webhook forwarding
```

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

**Iteration cap:** The loop runs at most 10 rounds. If the cap is hit, the model is given one final turn to produce a text response; if no text is produced, the review body contains a `[TOOL CAP REACHED]` notice.

**Behavioral contract:** The `buildCriticConstitution(toolsAvailable)` helper emits one of two system-prompt sections. When tools are available, the prompt instructs the model to call `read_file` / `list_directory` before making cross-file claims and to mark unverified claims `[NON-BLOCKING] NEEDS VERIFICATION`. When tools are NOT available (non-OpenAI provider or forked PR where the access probe failed), the prompt explicitly tells the model no tools are wired up and that all cross-file claims MUST be marked non-blocking with `NEEDS VERIFICATION` — never blocking.

**Verification-mode preamble (mt#1656 / mt#1640 Fix 1):** `buildCriticConstitution` accepts a fourth parameter `priorReviewsPresent: boolean = false`. When the reviewer-worker detects that prior bot reviews already exist on this PR (R≥2 review), it passes `priorReviewsPresent=true`, which swaps the standard adversarial preamble for a verification-mode preamble. The verification preamble reframes the task from unbounded adversarial discovery to bounded verification of the prior round's fixes: new BLOCKING findings are legitimate only when (a) introduced by the fix commit itself, or (b) a critical correctness/security/data-loss issue R1 missed. Otherwise the event verdict defaults to APPROVE. The reframe targets the no-stopping-rule structural problem (mt#1640): the standard preamble's "find SOMETHING every round" framing is correct for R1 but produces bikeshedding at R8+ when the diff has shrunk and substantive issues are addressed. R1 reviews always use the standard preamble (the default is `false`).

**Path normalization (`normalizeContentPath`):** User-supplied paths are normalized before calling the Contents API: `.`, `./`, `/`, and empty all map to `""` (repo root); leading `./` is stripped; leading slashes (e.g. `/src/foo.ts` → `src/foo.ts`) are stripped; trailing slashes are stripped. This absorbs common LLM path conventions that would otherwise produce spurious 404s.

**Tool result envelope:** Every tool call returns a JSON envelope so the model can disambiguate success/failure and parse structured metadata:

- `read_file` on a text file → `{"ok": true, "content": string, "truncated": boolean}`. `truncated: true` means GitHub's Contents API returned only a partial snippet (files above ~1MB); the prompt tells the model to mark any claim about the full contents as `NEEDS VERIFICATION`.
- `read_file` on a binary file → `{"ok": true, "content": "[BINARY FILE: N bytes, not decoded]", "truncated": boolean, "binary": true, "size": N}`. Binary files are detected by a NUL byte in the first 8KB (the `file(1)` heuristic); they are not decoded as UTF-8 because doing so would burn context on gibberish. `size` is the authoritative repository-stored file size reported by the GitHub Contents API (not the bytes fetched). `truncated: true` indicates the binary exceeded the API's ~1MB threshold (rare in practice since we never decode the snippet anyway, but surfaced for completeness).
- `read_file` on a missing file → `{"ok": false, "error": "not_found"}`.
- `list_directory` on a directory → `{"ok": true, "entries": [{"name", "type"}, …]}` where `type` is one of `file`, `dir`, `symlink`, or `submodule`. The four types are passed through so the model can see symlinked configs and submodule references accurately.
- Unexpected errors on either tool → `{"ok": false, "error": "<message>"}`.

The envelope structurally disambiguates "missing file" from "file whose content happens to be the literal string `null`" — a failure mode of the earlier raw-string protocol.

## Self-hosting

The service is deliberately stateless. Any deployment target that supports Node.js webhooks works (Railway, Fly, Vercel Functions, Render). Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely.

## Troubleshooting

### Network-call timeouts (mt#1086)

Outbound model and GitHub API calls are wrapped with `AbortController` timeouts. Without timeouts, a hung outbound call holds the worker open until the platform kills it (~30-60s on Railway, longer elsewhere); with them, you see the failure in service logs immediately and the sweeper (mt#1260) re-triggers the review on its next pass.

**Defaults:**

- `REVIEWER_MODEL_TIMEOUT_MS=120000` — model API calls (OpenAI / Anthropic / Google). 120s is sized for `gpt-5` with `reasoning_effort=high` on a Tier-3 PR, which regularly takes 60-90s end-to-end. Lower it for faster fail-fast on stuck rounds; raise it if you regularly see legitimate completions exceeding 2 min.
- `REVIEWER_GITHUB_TIMEOUT_MS=30000` — GitHub REST and GraphQL calls. 30s is generous; happy-path GitHub calls return in <5s. Lower it if you want to surface GitHub-side latency faster.

**Validation:** both env vars must parse as positive integers. `0`, negative numbers, decimals, non-numeric strings, and whitespace-padded values are rejected at boot with a clear error pointing at the env var name. The reviewer will not start with malformed timeout config — by design, since silent NaN coercion would produce infinite waits, defeating the point.

**Observing timeouts:** when a call exceeds its budget, a structured-shape JSON log is emitted to stderr with `event: "timeout"`, the operation name (e.g. `openai.chat.completions.create.toolloop`, `github.pulls.listFiles`), the configured `timeoutMs`, and elapsed `durationMs`. Then a typed `TimeoutError` propagates through `runReview`, gets caught by the detached-review handler in `server.ts`, and is logged as `review_error` with the timeout's operation name in `error`. The webhook returns 200 immediately on receipt regardless (ack-immediate per mt#1191); the sweeper (mt#1260) catches missed reviews on its next pass, so GitHub-level retry is not required here.

**Tuning advice:** start with the defaults. If model timeouts fire on legitimate review activity, the right move is usually to lower `reasoning_effort` rather than to raise the timeout — a model that needs >2 min on a Tier-3 PR is usually exhausting reasoning budget without producing useful output. If GitHub timeouts fire, check that the reviewer App's installation token is current and that you aren't rate-limited.
