# ADR-022: Session vs. conversation — the workspace / session / conversation terminology

## Status

Proposed

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

We will migrate in **tiers** and **defer** the breaking public rename:

- **Non-breaking now:** disambiguate where the overload causes wrong behavior/confusion (cockpit id-space hardening + MCP-"session" prose, mt#2525) and label harness-conversation surfaces "conversation" (cockpit + `transcripts_*` params with back-compat aliases, mt#2526).
- **Structural, rename-independent:** branded id types (`WorkspaceId`/`ConversationId`/`McpSessionId`) so wrong-id is a compile error at zero runtime cost (mt#2524).
- **Deferred (gated):** the full `session_*` → `workspace_*` public-API rename (mt#2527), gated on this ADR's acceptance + an explicit go-decision, given the blast radius (~546 files, ~72 public tools, breaking API).

(Why "workspace" not "worktree": Minsky sessions are full clones, deliberately not git worktrees — for isolation, multi-backend independence, and cloud-exec relocatability. Recorded here as context; may warrant its own ADR.)

## Consequences

**Easier:** one unambiguous word per concept ("find a past conversation" vs "list my workspaces" stop colliding); new surfaces converge on a documented vocabulary (`docs/architecture/cockpit.md`'s existing "workspace/transcript session" usage becomes the sanctioned direction); the branded-id work makes the mt#2420 id-space bug class structurally impossible with no public-API change.

**Harder / committed:** "session" now means two things by design (harness conversation + MCP transport) — acceptable because they rarely co-occur and both are ecosystem-sanctioned; the full M rename is large breaking debt carried as deferred (mt#2527), so until it ships `session_*` keeps the old name and prose must qualify "workspace"; a back-compat alias window is required for the `transcripts_*` param renames.

## Cross-references

- Related ADRs: ADR-006 (agent identity — `agentId` vs `agent_session_id`), ADR-017 (transcript capture), ADR-021 (project scoping)
- Related tasks: mt#2522 (epic), mt#2513 (this decision + full inventory/research), mt#2523–2527 (tracks), mt#2516 (param bug), mt#2420 (id-space bug), mt#2191 (origin, CLOSED), mt#2234 (indexing)
- Research: 2026-06-18/19 inventory + ecosystem + branded-types research, persisted in mt#2513's spec
