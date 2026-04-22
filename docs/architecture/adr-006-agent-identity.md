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

## Decision

Three capture layers, resolved by authority. The higher-authority layer wins when more than one fires.

### Layer 3 — Enforced

A Minsky-shipped Claude Code PreToolUse hook reads `session_id` from the hook's stdin JSON (confirmed present in Claude Code's current hook contract) and injects it into `_meta["io.minsky/agent_id"]` on every outgoing MCP tool call. Identity is structurally present for Claude Code callers regardless of whether upstream ships `agent_context`. When #32514 ships, the hook reads from that field and formats it into our scheme; downstream is unchanged.

**Threats handled:** confusion (different tabs get different `session_id`), silence (hook always fires for Claude Code calls).
**Threats not handled:** forgery (the hook runs in trusted Claude Code, but nothing verifies the injected value against the conversation it claims to name).

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

None today. Threat model: single-user Minsky, trust anchored at the user's machine. The format is designed so that when multi-user deployment becomes a real need, a Layer 0 verification (JWT-signed `clientAuth` as SEP-1289 proposes, or OAuth 2.1 Bearer as the MCP Authorization draft mandates) slots in above Layer 3 without changing the `agentId` format itself. The authenticated principal lives at the auth layer; agentIds continue to do intra-principal correlation.

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

**Transport auth (OAuth 2.1 / SEP-1289 / MCP Authorization draft).** Heavy for local single-user tooling. Identifies the application, not the conversation. MCP Authorization is drafting; SEP-1289 is dormant. Rejected as premature but accommodated as a future Layer 0.

**Decentralized identity (DIDs + Verifiable Credentials).** No production deployments; infrastructure (ledger, issuers, wallets) disproportionate to the coordination problem we have today. Rejected; remains a long-term target if the ecosystem moves.

**Wait for SEP-1289 / #32514 / `CLAUDE_SESSION_ID` to ship.** All three have been open for a year or more with no movement. Waiting blocks mt#1000 and mt#441. Rejected; our scheme absorbs any of them landing without rework.

**Single declared layer via `_meta`.** Claude Code doesn't cooperate today (no `agent_context` injection until #32514 ships). A declared-only scheme produces no signal for Claude Code, which is the majority of traffic. Rejected.

**Single enforced layer (hook only).** Hook is Claude-Code-specific. Other harnesses fall back to nothing. Rejected.

**Prompt-level self-identification ("tell the agent to include its ID in calls").** Sub-agents can't know they are sub-agents (the argument in #32514). Fails the case that makes identity interesting. Rejected.

## Implementation

Tracked in mt#1078 (Layer 1 + Layer 2 readers, format parser, MCP server integration, `_meta` convention docs). Phases after Layer 2 are gated on external events:

- Phase 1 (mt#1078) — Layer 1 (ascribed) and Layer 2 (declared `_meta` reader). `agentId` resolver, kind normalization table, hash construction, `_meta["io.minsky/agent_id"]` convention documented for callers.
- Phase 2 — Layer 3 Claude Code PreToolUse hook (separate follow-up task once hook-compilation approach is settled).
- Phase 3 (gated on upstream) — switch Layer 3 to read `agent_context` when/if [anthropics/claude-code#32514](https://github.com/anthropics/claude-code/issues/32514) lands.
- Phase 4 (gated on deployment pressure) — Layer 0 JWT verification for multi-user scenarios.
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
