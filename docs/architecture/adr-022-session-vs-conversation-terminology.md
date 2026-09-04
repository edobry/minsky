# ADR-022: Session vs. conversation — the workspace / session / conversation terminology

## Status

Accepted — amended 2026-09-04 (transport sense retired; fourth sense recorded). Originally accepted 2026-07-06, ask f0782a96 — "Agreed with all" on the July 2026 audit decisions; living record: memory 805ef48f.

**Rollout is staged, not gated.** The principal funded the full rename as two tiers rather than deferring it behind a future go-decision:

- **Stage 1 (mt#2686, this commit):** new code, docs convention, and cockpit routes/components adopt workspace/conversation/transport-session now. `session_*` tools, params, DB columns, and `~/.local/state/minsky/sessions/` paths are untouched.
- **Stage 2 (mt#2527):** the breaking mechanical `session_*` → `workspace_*` public-API rename, no longer deferred-gated on this ADR's acceptance — it is scheduled, ungated follow-on work.

## Context

"Session" is overloaded across three unrelated concepts, making Minsky hard to think about, talk about, and search:

- **Minsky per-task work area** — an isolated full `git clone` + branch bound to a task (`SessionRecord`, ~59 `session_*` tools, `~/.local/state/minsky/sessions/`). Called "session" (and in prose "session workspace").
- **Harness conversation** — a Claude Code conversation UUID (`agent_session_id`, transcripts, `claude --resume`). Also "session."
- **MCP transport connection** — the client↔server connection (`Mcp-Session-Id`, `processRole`). Also "session."

Originating incident (2026-05-31): finding a past Claude Code conversation to `--resume` was ambiguous between `session_list` (work areas) and `transcripts_search` (conversations). The mt#2513 inventory found ~12,300 "session" occurrences across 546 files, ~72 public `session_*` identifiers, ~1,965 prose mentions, plus a live id-space bug (mt#2420: a workspace id passed where a conversation id was required, 404ing).

Alternatives weighed for the work-area concept: keep **"session"** (perpetuates the overload; "session" is ecosystem-owned by harnesses); **"worktree"** (rejected — Minsky uses full clones, not git worktrees, so it would name a mechanism we don't use); **"environment"** (neutral but collides with env-vars / Railway environments, and generic); **"workspace"** (the term clone/container-based peers — Gitpod, Daytona, Devin, OpenHands — use; already in-use as "session workspace"; its only collision, bun monorepo "workspaces", is a contained, different level that has coexisted without confusion). Ecosystem research confirmed **"session"** is the dominant harness-conversation term (Claude Code, Cursor, Codex, Aider, Cline, Replit, Google ADK, Devin), with "conversation"/"thread" as user/API variants. At acceptance, the MCP spec used **"session"** for the transport (`Mcp-Session-Id`); the 2026-07-28 revision removed it — see §Amendment (2026-09-04).

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

## Amendment (2026-09-04)

mt#4838 amends this ADR in place, gating mt#2527 phase 3. The sections above stand as the
historical record of what was accepted 2026-07-06; this section supersedes them wherever they
conflict.

### (a) The transport leg is retired

The MCP specification's [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
states, under "Major changes":

1. "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP
   transport … Servers that need cross-call state use explicit, server-minted handles passed as
   ordinary tool arguments" (SEP-2567).
2. "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake" (SEP-2575).

This ADR's transport-sense reservation rested on spec authority ("the MCP spec authoritatively
uses 'session' for the transport"). The 2026-07-28 revision removes that referent from the spec.
The reservation's basis is gone; the code artifact it named is not — see (b).

### (b) The stance ratified: bare "session" is not a Minsky word, for any sense

Stage 1's stricter posture (`.minsky/rules/terminology-workspace-conversation.mdc`) is ratified
as this ADR's own stance: **bare "session" is not a Minsky vocabulary word for any sense.** It
survives only as quoted foreign vocabulary, at four boundaries:

- Harness field names — `agent_session_id`, the stream-json `session_id` field.
- The frozen `minsky://session/<uuid>` deeplink URI type (ADR-029; the cockpit-deeplinks rule
  fixes it as permanent).
- The historical migration files that named it at the time.
- The frozen MCP transport artifact: the `mcp-session-id` header handling
  (`src/mcp/server.ts:982`, `src/mcp/shim/client.ts`, `src/commands/mcp/start-command.ts:486`)
  and the `McpSessionId` branded type (`packages/domain/src/ids.ts:66`, docblock `:63`).

That fourth boundary is **frozen, not deleted**. Which SDK package serves the `mcp-session-id`
header today, its installed version, and whether it implements the 2026-07-28 revision are
unestablished — they are mt#4608's own open questions (its SC1/SC2), and this amendment asserts
nothing about any of them. That determination, and the artifact's retirement once it is made,
belongs to mt#4608 (see §Follow-up below).

### (c) A fourth sense: the drive (working term; noun pending ask#11428)

A fourth concept needs marking, distinct from all three above: the cockpit's supervised
subject-surface that spawns and reconnects a harness process (`DrivenSessionRecord`,
`src/cockpit/driven-session-host.ts`). This ADR records it under the **working term "drive"** —
the owned noun is a principal decision, open as **ask#11428**, and choosing it is explicitly out
of this amendment's scope.

Verified lifecycle (module docblock `driven-session-host.ts:1-26`;
`packages/domain/src/storage/schemas/driven-sessions-schema.ts`):

- `localId` is minted at spawn, _before the conversation exists_.
- The record adopts a **series** of conversations over its life, not one conversation for life —
  `drivenSessionConversationsTable` (`driven-sessions-schema.ts:242`, ADR-044) is an insert-only
  history of every conversation ever adopted; the parent row's upsert overwrites
  `harness_session_id` on each adoption (docblock `:166-169`).
- It carries process state the conversation does not have — `pid`, `exitCode`, `crashError`,
  `stopRequested` — and a terminal state the conversation does not have (`unrecoverable`).
- `driverGeneration` (declared `:222`, incremented `:1100`) counts **driver processes**, not
  conversations.
- It is **not** the driver process — ask#9827 settled `actuator` → `driver` as the name for the
  transport that runs it, and the module docblock (`:1-26`) keeps the two apart: the host "owns
  the drive record" (line 5) but "does NOT know how a session driver is spawned" (line 9).
- mt#3515 ("fork-on-attach", verdict recommend-with-conditions) would let one drive's conversation
  series branch via `claude --resume --fork-session`. That is a **pending proposed change** to the
  adoption model above, not a settled invariant to encode as permanent.

**Vendor-side confirmation.** Claude Code's own vocabulary — verified first-hand against the CLI's
own string census and documentation (mt#4838's spec, "Claude Code's own vocabulary, verified
2026-09-02"; Notion `3cf937f0-3cb4-8167-9a32-fec433c55e94`) — already separates a durable
**conversation** from a running **session** that holds one. That is this ADR's existing
vocabulary; the finding confirms the target vocabulary needs no change, rather than driving one.

**What changes under each option for ask#11428** (no recommendation made here):

- **Own noun** — this ADR gains a distinct row for the drive using the chosen word; the rule's
  fourth row and mt#2527 phase 3's marker set and file manifests use that word in place of
  "drive".
- **Composite treatment** ("conversation + drive-state") — no new row; the concept is documented
  as a qualified variant of the conversation row, and mt#2527 phase 3 has no independent marker
  set to rename.
- **Other** (an option not yet on the table) — this section is revised again once the ask
  resolves; nothing else in this amendment depends on which of the three happens.

### (d) The alternatives record corrected

Line 22 above states workspace's "only collision" is bun monorepo "workspaces." That undercounts:
`workspace` is already a live parameter name in Minsky's own MCP API, meaning a repo
working-directory path (`WorkspaceSchema`, `src/adapters/mcp/schemas/common-parameters.ts:35`,
used in `BaseBackendParametersSchema` at `:78`), and `docs/architecture/main-workspace-ops.md:5`
uses "workspace" for the **main** checkout specifically (as distinct from a session workspace).
Recorded here as a correction to the record; reconciling the two usages — if reconciliation is
needed at all — stays with mt#2527 phase 0/2, out of this amendment's scope.

### Follow-up: mt#4608

mt#4608 ("Upgrade the MCP spec pin to 2026-07-28") owns retiring the frozen artifact named in (b).
This amendment does not wait on it — the vocabulary reservation is retired now, independent of
when the code artifact goes — and asserts nothing about mt#4608's own open questions (which SDK
package, which version, whether it implements the 2026-07-28 revision).

## Cross-references

- Related ADRs: ADR-006 (agent identity — `agentId` vs `agent_session_id`), ADR-017 (transcript capture), ADR-021 (project scoping), ADR-044 (the drive's conversation-adoption schema), ADR-047 (driver/transport split)
- Related tasks: mt#2522 (epic), mt#2513 (this decision + full inventory/research), mt#2523–2527 (tracks), mt#2686 (stage 1: vocabulary in new code/docs/cockpit + this Accepted flip), mt#2527 (stage 2: mechanical tool-surface rename, gated by this amendment's phase-3 precondition), mt#2516 (param bug), mt#2420 (id-space bug), mt#2191 (origin, CLOSED), mt#2234 (indexing), mt#4838 (this amendment), mt#4608 (freeze-and-retire owner for the transport artifact)
- Research: 2026-06-18/19 inventory + ecosystem + branded-types research, persisted in mt#2513's spec
- Funding decision: 2026-07-06, ask f0782a96; living record memory 805ef48f
- Open principal decision: ask#11428 (the drive's owned noun, or composite treatment)
