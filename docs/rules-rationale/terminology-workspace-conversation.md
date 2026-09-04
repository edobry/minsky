# Terminology: Workspace vs. Conversation vs. Drive vs. Transport Session — extended rationale

> Extracted from `.minsky/rules/terminology-workspace-conversation.mdc` (mt#3087 corpus trim,
> Phase 4; four-sense table and retirement detail added by mt#4838, 2026-09-04). The compiled
> rule corpus carries the four-sense table and both normative rules (what does NOT change, URI
> types are NOT renamed) in full; this file holds the fuller enumeration and cross-reference
> detail — including the boundary-use enumeration and freeze rationale that would not fit inside
> the source rule's growth budget (a `.minsky/rules/**` PR that grows `CLAUDE.md` more than 2,000
> bytes is denied at merge without a size justification; `hook-files.mdc §Growth-justification`).
> Nothing here changes agent behavior — the directive text in the rule is the complete behavioral
> contract.

## What this rule does NOT change — full enumeration

- No `session_*` MCP/CLI tool name, parameter name, or DB column is renamed.
- No `~/.local/state/minsky/sessions/` path changes.
- Back-compat aliases from mt#2526 (`transcripts_*` param renames) are untouched.
- Existing docs/prose keep their current vocabulary until stage 2 or an opportunistic edit —
  this rule does not require a docs back-fill pass.

## `minsky://` URI types are NOT renamed — full rationale

The entity-codec's type→route mapping already absorbs one such divergence today — the `session`
URI type resolves to the `/agents/:id` cockpit route, not a literal `/session/:id` path — and
continues to absorb the stage-1 cockpit rename the same way: the URI **type name** is a stable
public identifier; the cockpit **route/component name** is free to carry the new vocabulary.

## The transport sense retired (added 2026-09-04, mt#4838)

The rule's earlier reserving sentence — "the one place [bare `session`] is the authoritative
external-spec term (`Mcp-Session-Id`) with no better word" — rested on spec authority. The MCP
specification's [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
retired that referent, under "Major changes":

1. "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP
   transport … Servers that need cross-call state use explicit, server-minted handles passed as
   ordinary tool arguments" (SEP-2567).
2. "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake" (SEP-2575).

The reservation's basis is gone, so the rule now states the stricter stance directly: bare
`session` is not a Minsky vocabulary word for any sense. It survives only as quoted foreign
vocabulary, at exactly four boundaries — this is the full enumeration the source rule's table
only names in short form:

1. **Harness field names** — `agent_session_id` (the driven-session record's harness-conversation
   field) and the stream-json `session_id` field the harness itself emits. Neither is a Minsky
   coinage; both are quoted, not renamed.
2. **The frozen `minsky://session/<uuid>` deeplink URI type** — ADR-029 fixes the UUID as the
   _sole_ `minsky://<type>/<uuid>` target, so this URI type keeps naming the workspace sessionId
   permanently; see `cockpit-deeplinks.mdc` and the `## minsky:// deeplink URI types are NOT
renamed` section above.
3. **The historical migration files** that named "session" at the time they were written — DB
   migrations are an append-only record of what a schema looked like when applied, not prose to
   correct in place.
4. **The frozen MCP transport artifact** — the `mcp-session-id` header handling
   (`src/mcp/server.ts:982`, `src/mcp/shim/client.ts`, `src/commands/mcp/start-command.ts:486`)
   and the `McpSessionId` branded type (`packages/domain/src/ids.ts:66`, docblock `:63`). This one
   is **frozen, not deleted**: 10 non-test occurrences of `mcp-session-id` remain across 4 files
   under `src`/`packages` as of this amendment, and deleting the vocabulary now would falsify
   running code. Which SDK package serves the header today, its installed version, and whether it
   implements the 2026-07-28 revision are unestablished — those are mt#4608's own open questions
   (its SC1/SC2), not settled here. mt#4608 owns retiring this artifact once the upgrade lands (or
   stating in its own Outcome that it will not, in which case a standalone freeze-and-retire task
   is filed).

## The fourth sense — the drive (added 2026-09-04, mt#4838)

A fourth concept sits alongside workspace/conversation/transport: the cockpit's supervised
subject-surface that spawns and reconnects a harness process (`DrivenSessionRecord`,
`src/cockpit/driven-session-host.ts`). The rule records it under the **working term "drive"** —
the owned noun is a principal decision, open as **ask#11428**, and this rule does not pick one.

Verified lifecycle (module docblock `driven-session-host.ts:1-26`;
`packages/domain/src/storage/schemas/driven-sessions-schema.ts`):

- `localId` is minted at spawn, _before the conversation exists_.
- The record adopts a **series** of conversations over its life, not one conversation for life.
  `drivenSessionConversationsTable` (`driven-sessions-schema.ts:242`, ADR-044) is an insert-only
  history of every conversation ever adopted; the parent row's upsert overwrites
  `harness_session_id` on each adoption (docblock `:166-169`). An earlier draft of this task's own
  spec treated the binding as one-conversation-for-life; that was wrong and is corrected here.
- It carries process state the conversation does not have — `pid`, `exitCode`, `crashError`,
  `stopRequested` — and a terminal state the conversation does not have (`unrecoverable`).
- `driverGeneration` (declared `:222`, incremented `:1100`) counts **driver processes**, not
  conversations.
- It is **not** the driver process — ask#9827 settled `actuator` → `driver` for the transport that
  runs it, and the module docblock keeps the two apart: the host "owns the drive record" (line 5)
  but "does NOT know how a session driver is spawned" (line 9).
- mt#3515 ("fork-on-attach", recommend-with-conditions) would let one drive's conversation series
  branch via `claude --resume --fork-session`. That is a **pending proposed change** to the
  adoption model above, not a settled invariant.

**Vendor-side confirmation.** Claude Code's own vocabulary — verified first-hand against the CLI's
own string census and documentation (Notion `3cf937f0-3cb4-8167-9a32-fec433c55e94`) — already
separates a durable **conversation** from a running **session** that holds one, which is this
rule's existing vocabulary. The finding confirms the target vocabulary needs no change.

**What changes under each option for ask#11428** (no recommendation made here):

- **Own noun** — the rule's fourth row, this file, and ADR-022 all gain the chosen word in place
  of "drive"; mt#2527 phase 3's marker set and file manifests use it too.
- **Composite treatment** ("conversation + drive-state") — no new row anywhere; the concept is
  documented as a qualified variant of the conversation row.
- **Other** (an option not yet on the table) — these sections are revised again once the ask
  resolves.

## Cross-references

- `docs/architecture/adr-022-session-vs-conversation-terminology.md` — the ADR this rule
  operationalizes (Accepted 2026-07-06; amended 2026-09-04 by mt#4838).
- `cockpit-deeplinks.mdc` — the `minsky://` URI format; its `session` row notes the
  URI-type/route divergence this rule generalizes.
- mt#2522 — epic; mt#2524 (branded ids), mt#2525 (id-space hardening), mt#2526 (conversation
  labeling) — DONE prerequisite tiers; mt#2686 — this rule's originating task (stage 1);
  mt#2527 — stage 2 (the deferred mechanical tool-surface rename, gated by mt#4838's amendment).
- ADR-044 — the drive's conversation-adoption schema (`drivenSessionConversationsTable`).
- ADR-047 — the driver/transport split (`DriverTransport`, `ClaudeStreamJsonTransport`).
- mt#4838 — this file's 2026-09-04 update (transport sense retired, drive sense added).
- mt#4608 — owns retiring the frozen `mcp-session-id`/`McpSessionId` artifact once the MCP SDK
  pin upgrades past the 2026-07-28 revision.
- ask#11428 — the open principal decision on the drive's owned noun.
- Funding decision: 2026-07-06, ask f0782a96; living record memory 805ef48f.
