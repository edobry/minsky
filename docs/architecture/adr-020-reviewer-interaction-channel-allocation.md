# ADR-020: Reviewer interaction surface as a three-channel allocation

## Status

Proposed

## Context

`minsky-reviewer[bot]` can be triggered four ways, talks back three ways, and resolves its own threads — and none of those surfaces was designed against the others. They accreted one task at a time:

- `/review` as a PR comment triggers a fresh review (mt#2127), gated to repo collaborators, matched by an exact-first-line regex in `services/reviewer/src/server.ts`.
- `/resolve` as a PR comment resolves the bot's own threads (mt#2173) — landed weeks after `/review`, in the same regex pile.
- `POST /retrigger` triggers a review programmatically; mt#2346 moved its auth off the webhook-signing secret onto the operator's MCP token.
- The GitHub webhook fires a review automatically on push/open.
- The review body is emitted as structured output — findings, inline comments, spec-verification, a conclude verdict — composed deterministically from output-tool calls rather than scraped from free text (mt#1392).
- The reviewer replies to its own threads and auto-resolves them when a push addresses the finding, guarding human-opened threads (mt#1345).
- A persistent status comment (`status-comment.ts`) tracks review state on the PR.

Each was individually reasonable. Together they are a reviewer API nobody specified — two slash verbs, an HTTP endpoint, a webhook, an output-tool vocabulary, a status comment, a set of MCP thread tools. New verbs land wherever the implementing task happened to be working, with no frame to say which interaction belongs on which surface. The next five verbs will accrete the same way unless the surface is named.

This is the same class of decision Minsky already made for Asks (mt#1316), which allocated operator-attention requests across MCP elicitation versus an async inbox by their sync/async and human-versus-agent character. It also extends mt#1392 ("reviewer output as a structured channel"), which fixed the _outbound_ direction (structured tool-call payloads, not scraped text); this ADR covers the _inbound_ and _status_ directions.

Constraint worth naming up front: the comment and check-run surfaces are forge-shaped (GitHub `issue_comment`, review threads, `author_association` gating, the Checks API). Minsky already has a `ForgeBackend` abstraction (ADR-005); these surfaces must route through it rather than bake in GitHub. The MCP surface is forge-neutral by construction. A second constraint: GitHub restricts what a GitHub App may do on fork PRs (`pull_request` vs `pull_request_target`), which bounds whether the reviewer can comment or write check-runs on external-contributor PRs.

## Decision

We will treat the reviewer's interaction surface as **three deliberate channels**, each with a clear discriminator, rather than an open set of ad-hoc verbs and endpoints:

1. **PR comment thread — conversation and intent of record.** Carries content that must be a durable, human-readable record in the PR timeline: human-initiated triggers via a deliberately **minimal** command set (`/review`, `/resolve` today), human-addressed questions and answers, and finding-contest _resolutions_. The command grammar stays minimal by policy — bors shows that an expanding comment-command space fails (users misremember syntax), and CodeRabbit shows that comment-based chat becomes PR noise. New human-initiated commands should prefer check-run action buttons over new comment verbs.

2. **GitHub check-run — status, convergence, and liveness of record.** Carries the reviewer's convergence state ("round 3, 2 blocking remain"), failure/liveness surfacing, and human-initiated commands via the Checks API "requested actions" buttons. The check-run is the native, update-in-place, structured GitHub surface for CI-like status; it does not spam the comment thread on long-running PRs, and its action buttons are parse-free and separate from comment rate limits, and they work via the Checks API rather than requiring the comment-posting permission. (Who may _trigger_ a requested action still depends on repository/App permissions and is constrained on fork PRs — see the fork-PR note below; the design must degrade gracefully where buttons are unavailable, falling back to the minimal comment commands.) This is the in-PR complement to the off-cockpit alert sink (mt#1596 / mt#2364).

3. **MCP / programmatic — structured payload and single-caller program actions.** Carries the structured findings payload (mt#1392 output tools), machine retrigger (the `/retrigger` HTTP path, mt#2346), bulk thread operations, and context fetch (`session_pr_review_context`). Agent-to-agent and PR-author-agent acknowledgements route here, not through comments.

The discriminator, sharpened past "a human _could_ see it": route to the **comment** channel only when the content must be a durable human-readable record _in the PR timeline_; route status signals to the **check-run** channel; route structured payloads and single-caller programmatic actions to **MCP**. This is reinforced by a consumer split the original framing blurred: the PR _author_ is usually an agent (the implementing subagent) that wants structured ACKs and results on MCP, while the _human_ operator uses the PR to read status and belongs on the check-run. "An operator might be watching" is not sufficient to route an interaction to comments.

The comment and check-run surfaces route through `ForgeBackend` (ADR-005), not GitHub-specific calls.

## Consequences

Easier:

- New reviewer interactions have a home by construction; the "where does this verb go" question has a mechanical answer.
- Reviewer status and failures become visible where the operator already looks (the PR check-run), closing the in-PR half of the surfacing gap (mt#1596) that the off-cockpit sink (mt#2364) addresses out-of-band.
- The comment thread stays legible — a small command vocabulary plus conversation, not a status feed.

Harder / now committed:

- The comment-command surface must stay minimal; expansion requests are pushed toward check-run action buttons, which is more work than adding a regex.
- Status surfacing must be built on the Checks API and routed through `ForgeBackend`, rather than reusing the existing status-comment path.
- Fork-PR support is bounded by the GitHub App permission model; the surfacing design must degrade gracefully where the reviewer cannot write a check-run.

Implementation follow-ups (filed as their own tasks, not phases of this ADR):

1. **Check-run surfacing first** — convergence state + failure/liveness as a check-run. This is the current gap; the activation gate is observable ("no check-run surfacing exists today").
2. **Minimal comment-command grammar** — a first-class verb registry + author-gating replacing the per-verb regexes in `services/reviewer/src/server.ts`.
3. **Forge-abstraction routing** — comment + check-run surfaces through `ForgeBackend`. This follow-up must define a minimal **capability contract per channel** in `ForgeBackend` terms (likely a `ChecksOperations` subinterface alongside the existing review-thread operations) and a **degradation policy** for forges lacking a primitive: a forge with no check-run-requested-actions equivalent omits the buttons and falls back to the minimal comment commands or MCP-only; a forge with no structured check-run surfaces status via the status comment. GitHub-specific richness (requested actions, review-thread semantics) is allowed _behind_ the capability contract, not leaked into the channel-allocation logic.

The agent-to-agent / mesh-over-PR-comments angle is genuinely strategic and multi-phase; it is a **separate research RFC**, not part of this decision.

Alternatives considered:

- **MCP-only** (no comment/check-run surface). Rejected: loses the human-visible, GitHub-native conversation and status that operators rely on.
- **Everything-on-comments.** Rejected: comment noise on long PRs, brittle free-text parsing, ignores the native Checks API, and pressures comment rate limits under a chatty mesh.
- **Status-on-comments** (the original two-channel framing). Rejected on expert review: GitHub check-runs are the native, update-in-place, structured surface for status, with action buttons that beat comment commands for human-initiated control.
- **Status quo** (ad-hoc accretion). Rejected: verbs land wherever the implementing task is working, with no frame; the surface grows incoherent.

## Cross-references

- Related ADRs: ADR-005 (ForgeBackend subinterfaces — the forge abstraction these surfaces route through).
- Decision precedent: mt#1316 (Asks ↔ MCP-elicitation transport allocation); mt#1392 (reviewer output as a structured channel — the outbound complement, Notion position paper).
- Current surfaces framed here: mt#2127 (`/review`), mt#2173 (`/resolve`), mt#2346 (`/retrigger` auth), mt#1345 (reply-to-thread + auto-resolve, DONE).
- Surfacing tie-in: mt#1596 (reviewer-failure surfacing gap), mt#2364 (off-cockpit Telegram sink — the check-run is the in-PR complement).
- Reviewer reliability/convergence epic: mt#1552; convergence-state framing: mt#1640.
- Prior art: Mergify (`@mention` command grammar), bors/bors-ng (minimal trigger command set), CodeRabbit (comment-chat noise), GitHub Checks API "requested actions", the GitHub `pull_request` vs `pull_request_target` fork-PR permission boundary.
- Origin: 2026-06-10 reviewer-API discussion + an opus Chinese-wall expert review whose two BLOCKING findings (fuzzy discriminator; check-runs under-treated) drove the two-to-three-channel reshape and the ADR-over-RFC reframe.
