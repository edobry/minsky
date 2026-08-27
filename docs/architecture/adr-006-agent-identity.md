# ADR-006: Agent identity scheme for MCP callers

**Status:** Accepted — April 2026
**Context task:** mt#953
**Companion:** [Position: Agent identity is an authority question](https://www.notion.so/34a937f03cb48143bfbedd8710972daf)

## Context

Minsky session records have an `agentId` column (added in mt#951, migration 0022) that was reserved for tracking which agent is acting in a given session. It was left unpopulated pending the research in mt#953, because the question "who is this?" turned out to be harder than the column's type signature suggested.

System 2 / Mesh features depend on this being filled: mt#1000 (scope-overlap signals), mt#441 (native subagent system), any future cross-session coordination. Until `agentId` is meaningful, those features either produce bad data or don't work at all.

### What the question actually asks

"Who is this?" decomposes into three granularities:

1. **Kind** — which harness (Claude Code, Codex, Cursor, Zed, Linear's agent, the user's own script)
2. **Instance** — which specific session, conversation, or tab of that harness
3. **Actor** — which agent inside that instance (main vs subagent, nested subagents)

Answering (1) is easy. Answering (2) and (3) is where the ecosystem hasn't shipped the primitive.

### What MCP actually exposes (empirical)

Captured from live invocations (fixtures: `docs/research/fixtures/mt953-claude-code-2.1.117-capture.jsonl`, `mt953-claude-code-subagent-capture.jsonl`):

- `clientInfo.name = "claude-code"` (not `claude-ai`, which is what older third-party docs claim).
- Extended `clientInfo` fields beyond MCP spec: `title`, `version`, `websiteUrl`, `description`.
- `clientCapabilities = {elicitation: {form: {}}, roots: {}}`.
- Environment: `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli` (interactive) or `sdk-cli` (headless), `CLAUDE_CODE_EXECPATH=…`.
- `RequestHandlerExtra.sessionId` is empty on stdio (populated only for HTTP transport).
- `_meta` on tool calls carries `progressToken` (MCP standard) and `claudecode/toolUseId` (Claude-Code-specific, per-invocation, not per-conversation).
- **Task-tool subagents share the parent's MCP connection**. Captured: one connection, one `clientInfo`, no marker distinguishing subagent calls from main-agent calls. Confirms the premise of upstream [anthropics/claude-code#32514](https://github.com/anthropics/claude-code/issues/32514).

### What the ecosystem ships (or doesn't)

Eight positions exist, reducible to four authority modes (see the companion position paper for detail):

1. **Transport auth** (OAuth 2.1 Bearer tokens, A2A, [SEP-1289](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289) — dormant)
2. **Protocol-native primitives** (A2A Agent Cards; SEP-1289 again — dormant)
3. **Payload-declared metadata** (Langfuse W3C Trace Context in `_meta`; [#32514](https://github.com/anthropics/claude-code/issues/32514) `agent_context` — open, no response)
4. **Environment-enforced** (Claude Code hooks with access to `session_id`; Cloudflare Mesh)
5. **Policy middleware** (Permit.io, Cerbos)
6. **Decentralized identity** (W3C DIDs + VCs, AIP — no deployments)
7. **Zero-Trust / principal-of-action** (Cloudflare, Microsoft, CyberArk — enterprise)
8. **Agent self-identification by prompt** — rejected because sub-agents can't know they are sub-agents

The critical fact: every MCP-specific identity proposal we could depend on is stuck. SEP-1289 has no sponsor, `CLAUDE_SESSION_ID` hasn't shipped, `agent_context` injection hasn't shipped. Waiting blocks mt#1000 and mt#441.

**Status update (2026-07-29, mt#3285):** the stuck proposals died — [#32514](https://github.com/anthropics/claude-code/issues/32514) closed by stale-bot 2026-05-11 (locked 2026-06-30); SEP-1289 closed 2026-04-07; the MCP 2026-07-28 spec revision moves the transport stateless and delegates identity to OAuth/OIDC, so no ambient session identity is coming from the protocol. What DID ship, quietly, is Claude Code setting the conversation UUID as the `CLAUDE_CODE_SESSION_ID` env var on spawned MCP server processes — the signal Phase 2 now consumes (see §Layer 3 amendment).

## Decision

Three capture layers, resolved by authority. The higher-authority layer wins when more than one fires.

### Layer 3 — Enforced

A Minsky-shipped Claude Code PreToolUse hook reads `session_id` from the hook's stdin JSON (confirmed present in Claude Code's current hook contract) and injects it into `_meta["io.minsky/agent_id"]` on every outgoing MCP tool call. Identity is structurally present for Claude Code callers regardless of whether upstream ships `agent_context`. When #32514 ships, the hook reads from that field and formats it into our scheme; downstream is unchanged.

**Threats handled:** confusion (different tabs get different `session_id`), silence (hook always fires for Claude Code calls).
**Threats not handled:** forgery (the hook runs in trusted Claude Code, but nothing verifies the injected value against the conversation it claims to name).

**Amendment (2026-07-29, mt#3285):** Phase 2 shipped with the injection point moved from a
PreToolUse hook to the Minsky stdio proxy (`src/mcp/stdio-proxy/conversation-identity.ts`). The
documented hook output contract (`updatedInput`) replaces a tool's ARGUMENTS only — there is no
hook path to protocol-level `_meta` — while the proxy sits on the raw JSON-RPC stream and
already parses every inbound line. The conversation id comes from `CLAUDE_CODE_SESSION_ID`,
which Claude Code sets in the environment of every MCP server process it spawns (verified live
2026-07-29 across five concurrent conversations): the upstream signal this ADR tracked as
"`CLAUDE_SESSION_ID` hasn't shipped" DID ship, as a spawn-time env var under a slightly
different name, and Phase 2 consumes it with a reader addition exactly as the format promised.
An already-declared `_meta["io.minsky/agent_id"]` is preserved, not overwritten (forward-compat
with mt#2292 subagent-grain declarations). Threat profile unchanged (confusion and silence
handled; forgery not). Known limitation: the env value is fixed at proxy spawn, so an
in-process conversation switch (`/clear`, in-process resume) attributes calls to the pre-switch
conversation until the next reconnect respawns the proxy; upgrade path if that bites is a
SessionStart hook writing a `<claude-pid> → sessionId` mapping the proxy re-reads per request.

**Amendment (2026-08-24, mt#3900 + mt#3812):** the "upgrade path if that bites" named at the end
of the previous paragraph SHIPPED — read that Known limitation as resolved on one transport and
still live on the other, not as open future work. mt#3900 implemented the `<claude-pid> →
sessionId` mapping (`@minsky/shared/conversation-pid-map`), and
`src/mcp/stdio-proxy/conversation-identity.ts` resolves it per request, so an in-process `/clear`
or resume no longer attributes calls to the pre-switch conversation **on the stdio-proxy path**.
It is NOT fixed uniformly: `minsky mcp shim` (ADR-038, mt#3812) deliberately does not import that
module — the shim's v1 scope names only the `CLAUDE_CODE_SESSION_ID` env-var path, and the import
would pull a `ps`-shelling dependency into a footprint the spec bounds — so spawn-pinning remains
exactly as described above on the shim — the local-daemon transport, which is the path in
use for this repo's own MCP access (verified 2026-08-24: a daemon serving port 48765). ADR-038
Question 6 still frames a default-flip as pending, so do not read this as a repo-wide default.

**Superseded in part by the 2026-08-27 amendment below** — the shim's exclusion described here is
now closed, and this paragraph's closing claim about WHY presence claims were affected was wrong.

**Amendment (2026-08-27, mt#4440): the shim gap is closed, and the earlier attribution was wrong.**

Two corrections, one of which matters more than the fix itself:

1. **The exclusion is gone.** Both writers — `src/mcp/stdio-proxy/conversation-identity.ts` and
   `src/mcp/shim/identity.ts` — now resolve through one shared implementation,
   `packages/domain/src/agent-identity/live-conversation.ts`, so an in-process `/clear` or resume
   is picked up on BOTH transports. The `ps`-shelling footprint concern that motivated the original
   exclusion was measured rather than assumed: the shim's bundle went 10,760 → 13,504 bytes
   against `rss-budget.test.ts`'s 51,200-byte gate, and its RSS 29 MB → 31 MB against that test's
   60 MB bound.
2. **The previous paragraph's closing sentence was FALSE, and the false version is the more useful
   record.** It read: _"Consumers that read the env var directly rather than going through either
   writer are pinned regardless of transport; mt#4440 tracks the presence-claim writer as one such
   case."_ The presence-claim writer does **not** read the env var. `src/mcp/server.ts`'s
   `resolveCallerIdentity` delegates to `resolveAgentIdWithLayer`, whose inputs are entirely
   caller-supplied, and `packages/domain/src/agent-identity/resolve.ts` contains zero `process.env`
   reads. It went **through** a writer — the shim — and propagated the shim's stale stamp
   faithfully.

   Why that mattered: the sentence named a real failure class (direct env readers ARE pinned) and
   attached the wrong instance to it, which sent mt#4440's own investigation to
   `src/mcp/server.ts`, then to `src/mcp/stdio-proxy/`, before a single `grep -c 'proxy' .mcp.json`
   — returning **0** across every MCP config — showed the proxy was not in the path at all. A
   correctly-stated general rule with a misattached example reads as diagnosis and costs the next
   reader the same detour.

Note the direct-env-reader class the sentence named does still exist and is unrelated to this fix:
`resolveCallerActorId` (`packages/domain/src/agent-identity/caller.ts`) reads `CLAUDE_AGENT_ID` and
`CLAUDE_CODE_SESSION_ID` as its CLI-path fallback (mt#4408, mt#4568). That path is correct where it
is used — the CLI runs as a child of the harness, so its environment names the current conversation
— and it is not on the presence-claim path.

### Layer 2 — Declared

A cooperating caller sets `_meta["io.minsky/agent_id"]` on each MCP request. Populated by:

- Minsky-dispatched native subagents (mt#441 sets this at dispatch with the correct parent chain)
- Remote triggers that know their run ID
- Any harness that opts into the convention

Matches Langfuse's `_meta`-for-correlation pattern. Uses the namespaced-`_meta` convention that Claude Code itself already uses (`claudecode/toolUseId`). Forward-compatible with any MCP-standard identity field that eventually ships.

**Threats handled:** silence for cooperating callers.
**Threats not handled:** forgery (no verification).

### Layer 1 — Ascribed

Fallback when Layers 3 and 2 don't produce a value. Construct an ID from `clientInfo.name` (normalized to the reverse-domain `kind` table below) plus SHA-256 hash of `(hostname, user, pid, start-time)`. Stable per MCP connection, non-colliding across connections.

**Threats handled:** silence (always produces some ID).
**Threats not handled:** confusion (multiple tabs with the same harness + different connections get different hashes, but not a conversation-scoped distinction), forgery.

### Format

```
{kind}:{scope}:{id}[@{parent-agentId}]
```

- `kind` — reverse-domain string, forward-compatible with SEP-1289. Normalization table:

| `clientInfo.name` / channel              | `kind`                      |
| ---------------------------------------- | --------------------------- |
| `claude-code`                            | `com.anthropic.claude-code` |
| `codex-tui`, `codex_vscode`              | `com.openai.codex`          |
| `cursor`                                 | `com.cursor.cursor`         |
| `zed` (or Zed's declared name)           | `app.zed.zed`               |
| Minsky-dispatched subagent               | `minsky.native-subagent`    |
| GitHub-App-based agent (non-MCP channel) | `github-app`                |
| No recognized signal                     | `unknown`                   |

- `scope` — how `id` is scoped: `conv` (conversation UUID), `run` (execution run), `proc` (process-level fallback), `inst` (installation), `hash` (last-resort hash).
- `id` — unique within kind+scope.
- `@parent-agentId` — optional nested delegation chain.

### Examples per scenario

| Scenario                                      | agentId                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Claude Code tab A, hook shipped               | `com.anthropic.claude-code:conv:8f3a2d1b-…`                                                   |
| Claude Code tab B, same machine, hook shipped | `com.anthropic.claude-code:conv:9c4e5f2a-…`                                                   |
| Claude Code inside remote trigger             | `com.anthropic.claude-code:conv:<id>@com.anthropic.triggers:run:<run-id>`                     |
| Task-tool subagent, pre-#32514                | Collapses to parent — **not distinguishable**                                                 |
| Task-tool subagent, post-#32514               | `com.anthropic.claude-code:conv:<parent>/task:<sub-id>@<parent-agentId>`                      |
| Codex CLI                                     | `com.openai.codex:proc:<host-hash>/<pid>` (ascribed; no instance signal today)                |
| Cursor                                        | `com.cursor.cursor:proc:<host-hash>/<pid>` (ascribed until Cursor-specific enforcement added) |
| Zed                                           | `app.zed.zed:proc:<host-hash>/<pid>` (ascribed)                                               |
| GitHub Copilot coding agent                   | `github-app:copilot-swe-agent:inst:<id>` (git/GitHub channel, not MCP)                        |
| Linear agent, other GitHub App-based agents   | `github-app:<slug>:inst:<id>`                                                                 |
| Minsky native subagent                        | `minsky.native-subagent:run:<task-id>@<parent-agentId>`                                       |
| No recognized signal                          | `unknown:hash:<sha256(host,user,pid,start)>`                                                  |

### Privacy

Hostnames hashed by default (SHA-256, first 16 hex chars). Opt-out via configuration for single-user deployments that prefer legibility.

### Verification

**Layer 0 (transport-auth) shipped via mt#1634 (May 2026)** for the hosted Minsky MCP HTTP transport. The deployed implementation is OAuth 2.1 Bearer per the MCP Authorization draft: `oidc-provider`-backed authorization-server endpoints (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/register`, `/oauth/authorize`, `/oauth/token`) plus a token-validation middleware on `/mcp` that validates issued bearer tokens against the persisted token store and enforces RFC 8707 audience binding. Successfully-validated tokens map to the principal class `oauth:claude-ai:user-<sub>@conv-<convId>` (the `@conv-<convId>` segment is omitted in v1; claude.ai-side conversation propagation is not yet wired). The principal is injected into the MCP request context so downstream consumers (mesh, audit, knowledge) see it as agentId.

The local stdio transport for Claude Code remains untouched — it doesn't go through the OAuth gate and continues to rely on Layers 1–3. Layer 0 specifically targets the hosted multi-user case (claude.ai web wiring) where the per-user identity is the load-bearing question and trust cannot be anchored at the caller's machine.

The format is designed so each layer slots in independently. The authenticated principal at Layer 0 lives in the auth layer; agentIds continue to do intra-principal correlation per the original three-layer scheme.

### Non-MCP callers

GitHub Copilot's coding agent, Linear's agent, and any future GitHub-App-based agent never hit Minsky's MCP server. They push commits and open PRs. Their identity flows through commit authorship and GitHub App installation IDs. The `github-app:<slug>:install:<id>` branch captures this channel explicitly, orthogonal to the MCP-channel branches.

## Consequences

### Positive

- **Ships with today's signals.** Layers 1 and 2 need only existing MCP fields plus a convention. Layer 3 needs only Claude Code's already-shipped hook contract.
- **Solves confusion and silence** for the Claude Code main agent case (the majority of Minsky traffic).
- **Honest about unsolved cases.** Task-tool subagents collapse to parent; documented, not papered over.
- **Forward-compatible.** SEP-1289 landing, `CLAUDE_SESSION_ID` shipping, or `agent_context` injection shipping each requires only a reader addition. Format doesn't change.
- **Orthogonal git-channel branch** handles Copilot / Linear / GitHub Apps without contaminating the MCP-channel scheme.
- **Minsky-dispatched subagents get correct parent chains** because Minsky controls dispatch.

### Negative

- **No forgery defense.** A caller can claim `_meta["io.minsky/agent_id"]: "com.anthropic.claude-code:conv:spoofed"` and Minsky will accept it. Acceptable under single-user trust; unacceptable for any multi-user deployment — first thing to fix.
- **Three code paths, resolved by priority.** More surface than a single-layer scheme.
- **Layer 3 is Claude-Code-specific.** Codex, Cursor, Windsurf, Zed fall to Layer 2 (if they cooperate) or Layer 1 (if they don't) until each harness has a stable hook API we can target.
- **Task-tool subagent gap.** Claude Code's subagent MCP calls are indistinguishable from the parent until upstream #32514 ships. Confirmed empirically.

### Open

- Claude Code Web — no capture yet; whether it speaks MCP to local servers and what transport are unknown.
- Anthropic remote triggers — no capture from inside one; run ID propagation mechanism unverified.
- Cursor, Zed `clientInfo.name` — not empirically verified (requires manual MCP config in each tool; deferred).

## Alternatives considered

**Transport auth (OAuth 2.1 / SEP-1289 / MCP Authorization draft).** Heavy for local single-user tooling. Identifies the application, not the conversation. MCP Authorization is drafting; SEP-1289 is dormant. Initially deferred (April 2026); shipped via mt#1634 (May 2026) for the hosted Minsky MCP HTTP transport. claude.ai web's MCP integration drove the re-open — claude.ai requires the OAuth flow as a precondition for adding remote MCP servers, and the hosted Minsky MCP needs per-user identity that the static-bearer-token path cannot provide. The local stdio transport remains on the static-bearer path; Layer 0 is HTTP-transport-specific.

**Decentralized identity (DIDs + Verifiable Credentials).** No production deployments; infrastructure (ledger, issuers, wallets) disproportionate to the coordination problem we have today. Rejected; remains a long-term target if the ecosystem moves.

**Wait for SEP-1289 / #32514 / `CLAUDE_SESSION_ID` to ship.** All three have been open for a year or more with no movement. Waiting blocks mt#1000 and mt#441. Rejected; our scheme absorbs any of them landing without rework.

**Single declared layer via `_meta`.** Claude Code doesn't cooperate today (no `agent_context` injection until #32514 ships). A declared-only scheme produces no signal for Claude Code, which is the majority of traffic. Rejected.

**Single enforced layer (hook only).** Hook is Claude-Code-specific. Other harnesses fall back to nothing. Rejected.

**Prompt-level self-identification ("tell the agent to include its ID in calls").** Sub-agents can't know they are sub-agents (the argument in #32514). Fails the case that makes identity interesting. Rejected.

## Implementation

Tracked in mt#1078 (Layer 1 + Layer 2 readers, format parser, MCP server integration, `_meta` convention docs). Phases after Layer 2 are gated on external events:

- Phase 1 (mt#1078) — Layer 1 (ascribed) and Layer 2 (declared `_meta` reader). `agentId` resolver, kind normalization table, hash construction, `_meta["io.minsky/agent_id"]` convention documented for callers.
- Phase 2 (mt#3285 — shipped July 2026) — conversation-scoped identity for Claude Code callers: the stdio proxy resolves `CLAUDE_CODE_SESSION_ID` into `com.anthropic.claude-code:conv:<uuid>` and stamps `_meta["io.minsky/agent_id"]` on every inbound `tools/call`; the inner server's existing Layer-2 reader resolves it with no server-side changes. The PreToolUse-hook mechanism originally planned here cannot reach `_meta` per the documented hook contract — see the §Layer 3 amendment.
- Phase 3 (was: gated on upstream — DEAD as of 2026-07-29: [anthropics/claude-code#32514](https://github.com/anthropics/claude-code/issues/32514) closed by stale-bot 2026-05-11, locked 2026-06-30; no `agent_context` is coming) — retained for the record; if an upstream per-call identity field ever ships, it slots in as a reader addition per the format's forward-compat design.
- Phase 4 (mt#1634 — shipped May 2026) — Layer 0 OAuth 2.1 Bearer verification for the hosted Minsky MCP HTTP transport. `OAuthIdentityProvider` capability-based abstraction (mt#1662) backed by `InProcessOAuthProvider` (mt#1663, wraps `oidc-provider` + Postgres adapter), with discovery + DCR endpoints (mt#1664), PKCE + RFC 8707 authorize/token flow (mt#1665), and `/mcp` token-validation middleware + agentId propagation (mt#1666). Coexists with the existing static-bearer-token path for local stdio.
- Phase 5 (gated on per-harness readiness) — equivalent Layer 3 hooks for Codex, Cursor, Windsurf, Zed as their hook APIs mature.

Each phase is separately shippable; earlier phases produce value without waiting for later ones.

## References

- Position paper: [Notion — Position: Agent identity is an authority question](https://www.notion.so/34a937f03cb48143bfbedd8710972daf)
- Research: `docs/research/mt953-mcp-signals.md`, `docs/research/mt953-ecosystem-survey.md`
- Fixtures: `docs/research/fixtures/mt953-claude-code-2.1.117-capture.jsonl`, `docs/research/fixtures/mt953-claude-code-subagent-capture.jsonl`
- Session schema: `src/domain/storage/schemas/session-schema.ts` (`agent_id` column, migration 0022)
- SessionRecord type: `src/domain/session/types.ts:35`
- Gating tasks: mt#1000 (mesh signal channel), mt#441 (subagent system)
- Implementation follow-up: mt#1078 (Layer 1 + Layer 2 readers, format parser, MCP server integration)
- Upstream: [MCP Authorization draft](https://modelcontextprotocol.io/specification/draft/basic/authorization), [SEP-1289](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289), [Claude Code #32514](https://github.com/anthropics/claude-code/issues/32514), [Claude Code #25642](https://github.com/anthropics/claude-code/issues/25642), [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
