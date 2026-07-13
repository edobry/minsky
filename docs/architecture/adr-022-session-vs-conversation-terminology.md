# ADR-022: Session vs. conversation — the workspace / session / conversation terminology

## Status

Accepted (2026-07-06, ask f0782a96 — "Agreed with all" on the July 2026 audit decisions; living record: memory 805ef48f).

**Rollout is staged, not gated.** The principal funded the full rename as two tiers rather than deferring it behind a future go-decision:

- **Stage 1 (mt#2686, this commit):** new code, docs convention, and cockpit routes/components adopt workspace/conversation/transport-session now. `session_*` tools, params, DB columns, and `~/.local/state/minsky/sessions/` paths are untouched.
- **Stage 2 (mt#2527):** the breaking mechanical `session_*` → `workspace_*` public-API rename, no longer deferred-gated on this ADR's acceptance — it is scheduled, ungated follow-on work.

## Context

"Session" is overloaded across three unrelated concepts, making Minsky hard to think about, talk about, and search:

- **Minsky per-task work area** — an isolated full `git clone` + branch bound to a task (`SessionRecord`, ~59 `session_*` tools, `~/.local/state/minsky/sessions/`). Called "session" (and in prose "session workspace").
- **Harness conversation** — a Claude Code conversation UUID (`agent_session_id`, transcripts, `claude --resume`). Also "session."
- **MCP transport connection** — the client↔server connection (`Mcp-Session-Id`, `processRole`). Also "session."

Originating incident (2026-05-31): finding a past Claude Code conversation to `--resume` was ambiguous between `session_list` (work areas) and `transcripts_search` (conversations). The mt#2513 inventory found ~12,300 "session" occurrences across 546 files, ~72 public `session_*` identifiers, ~1,965 prose mentions, plus a live id-space bug (mt#2420: a workspace id passed where a conversation id was required, 404ing).

Alternatives weighed for the work-area concept: keep **"session"** (perpetuates the overload; "session" is ecosystem-owned by harnesses); **"worktree"** (rejected — Minsky uses full clones, not git worktrees, so it would name a mechanism we don't use); **"environment"** (neutral but collides with env-vars / Railway environments, and generic); **"workspace"** (the term clone/container-based peers — Gitpod, Daytona, Devin, OpenHands — use; already in-use as "session workspace"; its only collision, bun monorepo "workspaces", is a contained, different level that has coexisted without confusion). Ecosystem research confirmed **"session"** is the dominant harness-conversation term (Claude Code, Cursor, Codex, Aider, Cline, Replit, Google ADK, Devin), with "conversation"/"thread" as user/API variants. The MCP spec authoritatively uses **"session"** for the transport (`Mcp-Session-Id`).

## Decision

We will adopt:

- **workspace** = the Minsky per-task isolated git-clone + branch (currently "session").
- **session / conversation** = the harness conversation; "session" matches ecosystem convention, surfaced as **"conversation"** in Minsky's own user-facing surfaces to keep it distinct from the workspace.
- **session** (MCP-transport-scoped) = the MCP connection, per the MCP spec, used only within transport machinery.

We migrate in **tiers**, funded end-to-end as a staged rollout (2026-07-06 decision) rather than gated behind a later go/no-go:

- **Non-breaking, shipped:** disambiguate where the overload causes wrong behavior/confusion (cockpit id-space hardening + MCP-"session" prose, mt#2525) and label harness-conversation surfaces "conversation" (cockpit + `transcripts_*` params with back-compat aliases, mt#2526).
- **Structural, rename-independent, shipped:** branded id types (`WorkspaceId`/`ConversationId`/`McpSessionId`) so wrong-id is a compile error at zero runtime cost (mt#2524).
- **Stage 1 (mt#2686, this commit):** new code, docs, and cockpit web routes/components converge on the vocabulary now — this ADR moves Proposed → Accepted as part of stage 1.
- **Stage 2, scheduled (mt#2527):** the full `session_*` → `workspace_*` public-API rename, given the blast radius (~546 files, ~72 public tools, breaking API). No longer gated on a future decision — the 2026-07-06 funding decision is that go-decision — but sequenced after stage 1 lands so the vocabulary convention exists before the mechanical rename executes against it.

(Why "workspace" not "worktree": Minsky sessions are full clones, deliberately not git worktrees — for isolation, multi-backend independence, and cloud-exec relocatability. Recorded here as context; may warrant its own ADR.)

## Consequences

**Easier:** one unambiguous word per concept ("find a past conversation" vs "list my workspaces" stop colliding); new surfaces converge on a documented vocabulary (`docs/architecture/cockpit.md`'s existing "workspace/transcript session" usage becomes the sanctioned direction); the branded-id work makes the mt#2420 id-space bug class structurally impossible with no public-API change.

**Harder / committed:** "session" now means two things by design (harness conversation + MCP transport) — acceptable because they rarely co-occur and both are ecosystem-sanctioned; the full mechanical rename is large breaking debt carried as scheduled stage-2 work (mt#2527), so until it ships `session_*` keeps the old name and prose must qualify "workspace"; a back-compat alias window is required for the `transcripts_*` param renames.

## Cross-references

- Related ADRs: ADR-006 (agent identity — `agentId` vs `agent_session_id`), ADR-017 (transcript capture), ADR-021 (project scoping)
- Related tasks: mt#2522 (epic), mt#2513 (this decision + full inventory/research), mt#2523–2527 (tracks), mt#2686 (stage 1: vocabulary in new code/docs/cockpit + this Accepted flip), mt#2527 (stage 2: mechanical tool-surface rename), mt#2516 (param bug), mt#2420 (id-space bug), mt#2191 (origin, CLOSED), mt#2234 (indexing)
- Research: 2026-06-18/19 inventory + ecosystem + branded-types research, persisted in mt#2513's spec
- Funding decision: 2026-07-06, ask f0782a96; living record memory 805ef48f
