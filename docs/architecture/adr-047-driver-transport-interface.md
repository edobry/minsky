# ADR-047: The cockpit's driver is a transport behind an interface; Minsky owns the supervisor and the substrate

## Status

**Accepted** — 2026-09-02. Decided by the principal at the close of the session/conversation
investigation, on a concise overview of the architectural shift ("Okay, sounds good. Let's go."),
after the recommendation had been corrected against the program's standing seam (see §Context).
Strategic half: the dated amendment at the top of the conversation-first drive RFC (Notion
`3a5937f0-3cb4-814c-990f-c1e3174b33e0`). Decision memory: mem#1369. Program umbrella: mt#4932,
under the harness-host ladder umbrella mt#2230.

## Decision (read this first)

**The cockpit is a harness-agnostic supervisor with a pluggable driver transport, and Minsky's
semantics live only in the substrate.** Three layers, each with an owner:

1. **Substrate — own, unchanged in role.** Tasks, workspaces, conversations, the adoption series
   (ADR-044), attention, succession (ADR-046), provenance, transcript ingest. The only place
   Minsky semantics live.
2. **Supervisor — own, slimmed.** The cockpit daemon keeps the drive record, driver generations,
   the advisory lock, restart policy and cost rows. It gains one input: Claude Code's per-process
   roster under `~/.claude/sessions/`, consulted before attaching, so a conversation another
   process holds is refused (mt#4869) or, for a held terminal conversation, driven only through
   its holder per mt#4870's verdict. It does **not** replicate the vendor supervisor's exit
   handoff of in-flight subagents and shell jobs; the drive RFC's interruption notice on resume
   remains the substitute.
3. **Driver transport — buy where the seam allows.** A `DriverTransport` interface with two
   implementations:
   - **`claude-stream-json`** — the existing genuine-binary pipe (`claude -p --input-format
stream-json --output-format stream-json`, `src/cockpit/driven-session-host.ts`). This stays
     the Claude Code driver under subscription auth. It is moved behind the interface, not
     rewritten (mt#4934).
   - **`acp`** — an Agent Client Protocol client (JSON-RPC 2.0 over stdio to an ACP agent
     subprocess; protocol v2 session methods `session/new`, `session/resume`, `session/close`,
     `prompt`, `cancel`, `session/update` notifications, permission requests surfaced as asks).
     Adopted first for non-Claude harnesses — Codex CLI, Gemini CLI, OpenCode, OpenHands all ship
     ACP agents — and for Claude Code **only** under API-key auth or an approval the principal
     obtains (mt#4936).

The drive record carries the harness kind, the transport id, the harness's own conversation id,
and a per-drive auth mode, `subscription` or `api-key` (mt#4935). The adoption table (ADR-044)
is unchanged.

## Context

**What changed.** Claude Code agent view (v2.1.196 → 2.1.258, August 2026) ships a native
supervisor: a job with a short id under `~/.claude/jobs/<id>/`, a worker process the daemon stops
after an hour idle and restarts on crash or update, exit handoff of in-flight subagents and shell
jobs to the next process, roster-based refusal of held conversations, and reply-from-outside
through agent view. That is the object the driven-session host (mt#2750, mt#3038) implements by
hand: job ≙ drive record, worker generation ≙ `driverGeneration`, conversation ≙ conversation.
The 2026-09-02 survey (Notion `3cf937f0-3cb4-8167-9a32-fec433c55e94`, §Prior art and §Profiles)
found that nobody publishes a supervisor that joins the daemon model to the transcript model, that
nobody ships the substrate layer, and that one cross-harness driver standard has real adoption:
the Agent Client Protocol (39 listed agents; clients in Zed, JetBrains, VS Code, Emacs, Neovim).

**The seam, which bounds the buy.** mt#2237 (the Rung 2 specification) and mt#2750 carry the
program's load-bearing constraint from the harness-host ladder RFC
(`372937f0-3cb4-8142-b3e3-c7238d3b51ba`), quoted from mt#2237 §Summary:

> Constraint (load-bearing): drive the genuine binary, NOT the Agent SDK. Genuine binary + user's
> own creds + user's own machine is the permitted seam; the Agent SDK with OAuth is the prohibited
> path.

The official ACP Claude adapter, `agentclientprotocol/claude-agent-acp`, is built on the Agent
SDK (its README: "This tool implements an ACP agent by using the official Claude Agent SDK"; its
`src/acp-agent.ts` spawns the CLI headlessly via `pathToClaudeCodeExecutable`, passes
`settingSources: ["user", "project", "local"]`, and passes `CLAUDE_CODE_OAUTH_TOKEN` through). The
Agent SDK documentation (`code.claude.com/docs/en/agent-sdk/overview`, read 2026-09-02) states:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
> login or rate limits for their products, including agents built on the Claude Agent SDK. Use
> the API key authentication methods described in the Quickstart instead.

Zed's documentation says its Claude Agent authenticates "with an API key or with Claude Code
where supported", so approvals exist. The constraint is therefore a policy fact, not a code
fact: the adapter would run under a subscription login; the program does not permit it. The
billing condition mt#2237 records (headless `claude -p` "still draw[s] from your subscription's
usage limits", corrected 2026-07-13, watch-gate mt#2235) is dated and was not re-verified for
this decision; it does not change the seam either way.

**How the recommendation was corrected.** The deciding conversation first recommended the ACP
Claude adapter as the first transport. The duplicate check on filing surfaced the seam in
mt#2237 and mt#2750, and the recommendation was corrected before any task was filed: Claude Code
keeps the genuine pipe; ACP enters through the other harnesses and API-key mode. The customer-
facing question — keep the seam, seek approval, or defer — is a vendor commitment and is parked
with the principal as ask#11489.

## Alternatives considered

- **Delegate supervision to Claude Code's daemon** (dispatch, reply, attach and subscribe over its
  control socket). Buys exit handoff, liveness and restarts for free. Rejected as the supervisor:
  Claude Code only, against a cross-harness thesis; an undocumented socket protocol that has
  already drifted between versions (`bg-jobs/` → `jobs/`); Anthropic disclaims the file formats;
  and its job holds one conversation for life, narrower than the adoption series. Its roster is
  adopted as an input; its socket stays a candidate channel for mt#4870.
- **ACP as the Claude Code transport first.** Rejected under subscription auth by the seam above.
  Retained for API-key mode and as the harness-agnostic transport.
- **Keep owning everything**, hand-rolled stream-json parsing included. Rejected: the transport
  is non-core and a standard now exists (`decision-defaults.mdc §Build vs buy`); owning the
  supervisor is the justified flip, since core relevance, three failing mature options, an
  already-built asset, and clear ownership all hold.

## Consequences

- `driven-session-host.ts` splits into a supervisor and a `DriverTransport` interface, with a
  parity test against a pre-refactor capture (mt#4934). The WebSocket protocol the SPA consumes
  (mt#2751) does not change.
- The drive record gains `harness_kind`, `transport_id`, `harness_conversation_id` and
  `auth_mode`, backfilled to today's values (mt#4935). `auth_mode: subscription` is refused for
  any harness other than Claude Code, and for `transport_id: acp` with Claude Code, at the
  transport.
- The per-harness transcript source becomes a seam; Claude Code's transcript tail is unchanged
  and remains the truth for entity-thread turns (ADR-044). The `--mcp-config` provisioning of a
  driven child (ADR-043) is preserved by the Claude transport.
- Attach admissibility reads the vendor roster (mt#4869); the held-conversation channel verdict
  amends the drive RFC's position 5 to "a held conversation is drivable only through its holder,
  or refused" (mt#4870).
- The drive's own noun (ask#11428) is downstream of this record: the entity it names is now
  harness-agnostic and outlives a series of adopted conversations, beside Claude Code's
  "background session" implemented as a "job".
- The customer-facing auth policy is not decided here (ask#11489). Until it is, a customer-facing
  drive of Claude Code uses the genuine binary under the customer's own login or an API key.
- mt#2237 (READY) still describes Rung 2 as a single-transport host; its owner should reconcile
  it against this record rather than implement it as written.

## Cross-references

- ADR-022 (workspace / conversation vocabulary; the `session` URI type is unchanged), ADR-023
  (cockpit delivery and the daemon boundary the supervisor lives behind), ADR-043 (agent tool
  surface registry: the MCP server set a driven child is provisioned with), ADR-044 (entity-thread
  turns derive from the harness transcript; the adoption table), ADR-046 (work package; the
  substrate's succession layer).
- RFC: Conversation-first drive (`3a5937f0-3cb4-814c-990f-c1e3174b33e0`, amended 2026-09-02);
  RFC: Minsky desktop app as harness host, the observe→drive ladder
  (`372937f0-3cb4-8142-b3e3-c7238d3b51ba`, source of the seam); RFC: the substrate
  (`367937f0-3cb4-813f-a71d-f269d28fe8fd`, intra-agent continuity across harnesses).
- Analysis: Claude Code — what "session" and "conversation" actually denote & Minsky relevance
  (`3cf937f0-3cb4-8167-9a32-fec433c55e94`).
- Tasks: mt#4932 (umbrella) and its children mt#4933 (this record), mt#4934, mt#4935, mt#4936;
  mt#4869, mt#4870; mt#2237, mt#2750, mt#3038, mt#2235; mt#4838 (ADR-022 amendment).
- Asks: ask#11489 (customer-facing auth), ask#11428 (the drive's noun).
- Memories: mem#1369 (decision record), mem#805 (Claude Code's transcript write model), mem#1356
  (Claude Desktop `/resume` through the holder).
