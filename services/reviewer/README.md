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

| Tool                   | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `read_file(path)`      | Read a file at the PR's HEAD ref. Returns file content or `null` (404).                       |
| `list_directory(path)` | List immediate children of a directory at HEAD ref. Returns `[{name, type}]` or `null` (404). |

Both tools use the `contents: read` permission the App already holds.

**Provider support (MVP):** OpenAI only. The reviewer runs a multi-turn completion loop — when the model returns tool calls, they are executed and results appended as messages, then the model is called again. Gemini and Anthropic fall back to the single-turn no-tools path and the service logs a warning (`[mt#1126] Running review without tools: …`) so operators can see why tool verification is absent.

**Tool gating (two axes):**

- **Provider capability.** Tools are only wired into the call when `REVIEWER_PROVIDER=openai`. Other providers receive the no-tools system prompt, which explicitly tells the model to mark cross-file claims as `NEEDS VERIFICATION` instead of `BLOCKING`.
- **Fork accessibility.** The App is installed on the base repo; it may not have read access to forks. When the PR originates from a different repo (`pr.head.repo !== pr.base.repo`), tools are disabled and the no-tools prompt is used — this avoids silent 404s from tool calls that can't resolve the head SHA. A fuller fix (probing fork access and enabling tools per-PR where possible) is tracked as a follow-up.

**Iteration cap:** The loop runs at most 10 rounds. If the cap is hit, the model is given one final turn to produce a text response; if no text is produced, the review body contains a `[TOOL CAP REACHED]` notice.

**Behavioral contract:** The `buildCriticConstitution(toolsAvailable)` helper emits one of two system-prompt sections. When tools are available, the prompt instructs the model to call `read_file` / `list_directory` before making cross-file claims and to mark unverified claims `[NON-BLOCKING] NEEDS VERIFICATION`. When tools are NOT available (non-OpenAI provider or forked PR), the prompt explicitly tells the model no tools are wired up and that all cross-file claims MUST be marked non-blocking with `NEEDS VERIFICATION` — never blocking.

**Path normalization (`normalizeContentPath`):** User-supplied paths are normalized before calling the Contents API: `.`, `./`, `/`, and empty all map to `""` (repo root); leading `./` is stripped; leading slashes (e.g. `/src/foo.ts` → `src/foo.ts`) are stripped; trailing slashes are stripped. This absorbs common LLM path conventions that would otherwise produce spurious 404s.

**Truncation handling:** Files above the Contents API size threshold (~1MB) return `truncated: true` with a partial snippet. The helper prepends `TRUNCATED_FILE_NOTICE` to the returned content so the model sees the caveat inline and can avoid confident-but-wrong claims against incomplete data.

## Self-hosting

The service is deliberately stateless. Any deployment target that supports Node.js webhooks works (Railway, Fly, Vercel Functions, Render). Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely.
