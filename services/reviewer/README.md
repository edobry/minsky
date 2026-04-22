# minsky-reviewer

Standalone Railway-deployed webhook service that posts adversarial PR reviews as a separate GitHub App identity. Implements the Chinese-wall review architecture described in the [Structural Review position paper](https://www.notion.so/34a937f03cb481b38babf9b676f2f168).

_Status: v1 deployed 2026-04-22 to Railway production; end-to-end smoke test tracked in [mt#1099](https://github.com/edobry/minsky/issues/mt-1099)._

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

## Self-hosting

The service is deliberately stateless. Any deployment target that supports Node.js webhooks works (Railway, Fly, Vercel Functions, Render). Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely.
