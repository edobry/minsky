# mt#953 — Identity Authority Analysis + Minsky's Position

**Status:** Motion report on the agent-identity problem space, followed by a synthesized position for Minsky. Feeds Phase 5 (the ADR).

## The core question

Before deciding _what_ an agentId looks like, we must decide _who has the authority to produce it_. This is the question the original spec did not surface. The answer shapes the format, the lifecycle, the trust model, and the failure modes.

Three distinct authority modes:

| Mode         | Who produces the ID                                                           | Cost                                | Trust                                          |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| **Ascribed** | The server, inferring from signals it receives (clientInfo.name, env, PID)    | Free — works with any caller        | Low — what you infer may be wrong or forgeable |
| **Declared** | The caller, claiming an ID in a payload field (`_meta`, `agent_context`, JWT) | Requires caller cooperation         | Medium — unverified claim, but intentional     |
| **Enforced** | The environment, injecting the ID via a hook or proxy the caller can't bypass | Requires control of the environment | High — structural, not policy-dependent        |

Minsky's "environmental pre-delegation" design principle (theory-of-operation.md) points strongly at **enforcement** — but pragmatically, all three modes have a role.

## Prior-art survey — the camps

Eight identifiable schools of thought on agent identity, each with a live artifact to point at. Ordered roughly from lightest to heaviest.

### Camp 1 — Transport auth (OAuth 2.1, Bearer tokens)

**Claim:** Identity is what an authorization server says it is, encoded in a signed token at the HTTP layer.

**Artifacts:**

- MCP's draft [Authorization spec](https://modelcontextprotocol.io/specification/draft/basic/authorization) mandates OAuth 2.1 + PKCE + Dynamic Client Registration (DCR) + Resource Indicators (RFC 8707)
- [A2A protocol](https://github.com/a2aproject/A2A) uses OAuth 2.0 / API keys / OIDC; identity lives at HTTP transport, not payloads
- [CIMD (Client ID Metadata Documents)](https://workos.com/blog/client-id-metadata-documents-cimd-oauth-client-registration-mcp) — OAuth Working Group's web-native client identity: the client_id IS a URL that hosts the client's metadata JSON

**Strengths:** Battle-tested; multi-tenant; revocable; scoped by audience.
**Weaknesses:** Identifies the _client application_, not the _specific conversation_ and certainly not _which sub-agent within the conversation_. Heavyweight for local single-user tools.

### Camp 2 — Decentralized identity (DIDs + Verifiable Credentials)

**Claim:** Every agent has a self-sovereign DID anchored on a ledger, with third-party-issued W3C Verifiable Credentials attesting capabilities and delegation.

**Artifacts:**

- [arXiv 2511.02841 "AI Agents with Decentralized Identifiers and Verifiable Credentials"](https://arxiv.org/abs/2511.02841)
- [W3C VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) (official Recommendation)
- [AIP — Agent Identity Protocol for Verifiable Delegation](https://www.researchgate.net/publication/403194121) — explicit cross-protocol (MCP + A2A) delegation

**Strengths:** Cryptographically verifiable; no central authority; cross-vendor trust; principled solution to delegation chains.
**Weaknesses:** Heavy infrastructure (ledger, issuers, wallets); nobody is using this in practice yet; premature for most current agent systems.

### Camp 3 — Protocol-native identity primitives

**Claim:** The agent protocol itself should define an identity field.

**Artifacts:**

- [A2A Agent Cards](https://github.com/a2aproject/A2A) — every A2A agent publishes `/.well-known/agent.json` with name, skills, auth flows; optionally JWS-signed for authenticity
- [MCP SEP-1289](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289) — proposes `clientId` (reverse-domain) + `clientAuth` (short-lived JWT) in MCP initialize. **Status: dormant.**

**Strengths:** Self-contained; one spec answers identity and auth at once.
**Weaknesses:** Standards move slowly; SEP-1289 is dormant; doesn't solve sub-agent hierarchy.

### Camp 4 — Context propagation via `_meta`

**Claim:** Identity is just another piece of per-request correlation metadata, analogous to W3C trace-context. Carry it in `_meta`, propagate it like a distributed trace.

**Artifacts:**

- [Langfuse MCP tracing](https://langfuse.com/docs/observability/features/mcp-tracing) — W3C Trace Context in `_meta.traceparent`
- MCP spec's `_meta` convention (standardized for `progressToken`; open-ended for custom keys)

**Strengths:** Matches observability conventions; composable with tracing; low ceremony; works today.
**Weaknesses:** Doesn't verify anything; nothing prevents spoofing; only as reliable as the caller's discipline.

### Camp 5 — Client-layer injection

**Claim:** Only the MCP client knows the agent hierarchy (main vs sub-agent). The client must inject identity into every tool call's parameters, because no amount of agent cleverness can solve "the sub-agent doesn't know it's a sub-agent."

**Artifacts:**

- [Claude Code issue #32514 — "Provide agent identity context to MCP tool calls"](https://github.com/anthropics/claude-code/issues/32514). Proposes:
  ```json
  "agent_context": {
    "agent_id": "unique-id-per-agent-instance",
    "parent_agent_id": "parent-unique-id"
  }
  ```
- Status: open March 2026, no maintainer response yet

**Strengths:** Directly solves the hierarchy problem that prompts-and-policy can't; zero agent cooperation required.
**Weaknesses:** Requires harness vendors to implement; out of our control for Anthropic's side. Works for Claude Code native subagents (the hierarchy is Claude-Code-managed) but not for cross-harness.

### Camp 6 — Policy enforcement above the protocol

**Claim:** Don't solve identity _in_ the protocol. Build middleware that wraps the protocol, handles identity, and enforces policy.

**Artifacts:**

- [Permit.io's "Ultimate Guide to MCP Auth"](https://www.permit.io/blog/the-ultimate-guide-to-mcp-auth) argues identity belongs in a policy layer _above_ MCP — "build a system where policies and relationships drive behavior, not static credentials"
- FastMCP and similar proxy middlewares
- [Cerbos — MCP and Zero Trust](https://www.cerbos.dev/blog/mcp-and-zero-trust-securing-ai-agents-with-identity-and-policy)

**Strengths:** Decouples identity from protocol; pluggable; supports any backend identity system.
**Weaknesses:** Adds a hop; one more thing to run; config-heavy.

### Camp 7 — Zero-Trust / Principal-of-Action

**Claim:** Agents act on behalf of someone. Every action carries a verifiable delegation chain: principal → agent → sub-agent → action. Nothing is trusted implicitly; every step is attested.

**Artifacts:**

- [Cloudflare Mesh](https://www.cloudflare.com/press/press-releases/2026/cloudflare-launches-mesh-to-secure-the-ai-agent-lifecycle/) (Agents Week 2026) — every agent carries a distinct identity; granular per-agent policy
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
- [CyberArk's Zero Trust for AI Agents](https://developer.cyberark.com/blog/zero-trust-for-ai-agents-delegation-identity-and-access-control/)
- RFC 8693 OAuth 2.0 Token Exchange for delegation tokens
- [ISACA — "The Looming Authorization Crisis"](https://www.isaca.org/resources/news-and-trends/industry-news/2025/the-looming-authorization-crisis-why-traditional-iam-fails-agentic-ai)

**Strengths:** Rigorous; auditable; the right answer for regulated / adversarial contexts.
**Weaknesses:** Enterprise-grade weight; premature for local tools; vertical integration with identity providers required.

### Camp 8 — Agent self-identification by prompt / policy

**Claim:** Tell the agent (via CLAUDE.md / system prompt / rules) to identify itself in every MCP call.

**Artifacts:**

- The naive intuition; considered and rejected in Claude Code issue #32514 ("sub-agents lack self-awareness")
- Plausible for _main_ agents; fails for sub-agents

**Strengths:** Zero infrastructure; works with any MCP server today.
**Weaknesses:** Policy-dependent; sub-agents don't know they're sub-agents; brittle under model changes; compounds with every rule.

## Emerging consensus

Across the eight camps, four points of convergence are visible:

1. **Identity is not a protocol property alone.** Every serious proposal (Permit.io, Cloudflare Mesh, Microsoft governance, AIP) treats identity as something that needs _infrastructure around_ the protocol — whether that's middleware, a policy layer, a ledger, or an identity provider.

2. **Client-side injection is necessary for hierarchy.** Both SEP-1289 (protocol-native) and Claude Code #32514 (client-native) agree: only the client knows the parent-child relationship of nested agents. The server cannot infer it. So sub-agent identity requires something the client passes.

3. **`_meta` is the de-facto carrier for per-request identity metadata.** Langfuse, W3C Trace Context, and proposed SEP fields all use it. This is the lowest-friction propagation channel.

4. **Reverse-domain naming is the emerging convention for harness kind.** SEP-1289 proposes it; OpenAI's Codex already uses `clientInfo.name` this way; it's the direction every spec-writing group has chosen. Aligning with it now costs nothing and avoids rework later.

## Five philosophical axes to choose on

Any scheme must pick a position on each axis. Here are the axes and Minsky's implicit choice:

| Axis            | Poles                                       | Minsky's context                                                                                              |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Authority**   | Ascribed ↔ Declared ↔ Enforced            | Mixed — prefer enforced for CC (hook), declared for cooperating vendors, ascribed as fallback                 |
| **Trust model** | Self-asserted ↔ Cryptographically verified | Self-asserted (single-user, local trust anchor); upgrade path to verified if multi-user comes                 |
| **Layer**       | Transport ↔ Protocol ↔ Payload ↔ Policy  | Payload (`_meta`) primary; policy (hook) for enforcement; neither transport-auth nor protocol-native required |
| **Granularity** | Kind ↔ Instance ↔ Actor ↔ Principal      | Need Kind + Instance + Actor (parent-child for sub-agents); Principal (the human) is out of scope             |
| **Delegation**  | None ↔ Linked ↔ Verified                  | Linked (parent-child chain stored); not verified                                                              |

## Minsky's position

A **layered pragmatic scheme** that ships today and evolves toward verifiable identity as standards mature.

### Three capture layers, resolved by priority

Highest-authority layer wins when they disagree.

**Layer 3 — Enforced (Claude Code hook, Minsky-provided)**

A Minsky-shipped PreToolUse hook for Claude Code reads `session_id` from the hook's stdin JSON (confirmed available — see [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)) and injects it into every outgoing MCP tool call's `_meta`. Structural enforcement — doesn't depend on agent compliance or vendor cooperation.

This is the Minsky-ish answer: environmental pre-delegation. The hook IS the identity mechanism for Claude Code callers. If Claude Code ships proper `agent_context` injection via #32514, we switch the hook to read from there instead; the downstream logic is unchanged.

**Layer 2 — Declared (caller-injected `_meta`)**

When a caller (Minsky native subagent, cooperating harness, remote trigger) wants to identify itself explicitly, it sets `_meta["io.minsky/agent_id"]` on each request. Minsky reads this directly — no verification, single-user trust model. This matches Langfuse's convention (and future SEP-1289, should it ship, would slot in as another `_meta`-adjacent field we could start honoring).

**Layer 1 — Ascribed (fallback from signals)**

When neither Layer 3 nor Layer 2 produces an ID, Minsky infers one from `clientInfo.name` + process signals:

- Kind from `clientInfo.name` (e.g. `claude-ai` → `com.anthropic.claude-code`; `codex-tui` → `com.openai.codex`)
- Instance from hash of (hostname, user, pid, start-time) — stable within a connection, non-colliding across

### Format

```
{kind}:{scope}:{id}[@{parent-agentId}]
```

- **`kind`** — reverse-domain string (forward-compat with SEP-1289)
- **`scope`** — `conv` (conversation UUID), `run` (execution run), `proc` (process-level fallback), `inst` (install), `hash` (fallback hash)
- **`id`** — unique within kind+scope
- **`@parent-agentId`** — optional, enables nested delegation chains

### Concrete examples per scenario row

| #   | Scenario                              | Produced by                                                    | Example agentId                                                                |
| --- | ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Claude Code desktop, tab A            | Layer 3 hook                                                   | `com.anthropic.claude-code:conv:8f3a2d1b-...`                                  |
| 2   | Claude Code desktop, tab B (parallel) | Layer 3 hook                                                   | `com.anthropic.claude-code:conv:9c4e5f2a-...` (different session_id)           |
| 3   | Claude Code on another machine        | Layer 3 hook                                                   | same `:conv:` kind; differs at session_id                                      |
| 4   | Claude Code Web                       | Layer 2 (if CC Web ever supports MCP) or N/A                   | `com.anthropic.claude-code-web:conv:<id>`                                      |
| 5   | Anthropic remote trigger              | Layer 2 via trigger env → hook                                 | `com.anthropic.claude-code:conv:<id>@com.anthropic.triggers:run:<run-id>`      |
| 6   | Codex CLI                             | Layer 1 (ascribed from `clientInfo.name`)                      | `com.openai.codex:proc:<host-hash>/<pid>`                                      |
| 7   | Cursor / Windsurf / Cline / Zed       | Layer 1 (ascribed)                                             | `com.cursor.cursor:proc:...`, `app.zed.zed:proc:...`                           |
| 8   | GitHub Copilot coding agent           | **Git channel, not MCP**                                       | `github-app:copilot-swe-agent:install:<id>`                                    |
| 9   | Linear agent                          | **Git channel, not MCP**                                       | `github-app:<slug>:install:<id>`                                               |
| 10  | Claude Code Task-tool subagent        | Layer 3 hook (if hook gets parent context) or Layer 1 fallback | `com.anthropic.claude-code:conv:<parent>/task:<subagent-id>@<parent-agentId>`  |
| 11  | Minsky native subagent (mt#441)       | Layer 2 (Minsky dispatches, so Minsky knows parent)            | `minsky.native-subagent:task:<task-id>@<parent-agentId>`                       |
| 12  | Nested Minsky sub-subagent            | Layer 2 recursively                                            | `minsky.native-subagent:task:<child-task-id>@<parent-agentId>` (chain repeats) |
| 13  | Unknown / no signal                   | Layer 1 fallback                                               | `unknown:hash:<sha256(host,user,pid,start)>`                                   |

### Privacy stance

- Hostnames hashed by default (SHA-256, first 16 hex chars)
- User-configurable to opt out of hashing (for single-user, this is fine; for future multi-user deployments, hashing is the default)
- Full hostname never transmitted outside Minsky's database

### Verification policy — today: none. Later: upgradable.

- Minsky does not cryptographically verify agent identity. Threat model: single-user, trust anchored at user's machine.
- The scheme's format is **compatible** with future verification: if SEP-1289 or a successor mandates signed clientAuth JWTs, we add JWT validation as a new Layer 0 (auth-layer); the agentId format doesn't need to change.
- If multi-user Minsky becomes a real deployment mode, upgrade path: adopt transport-layer auth (MCP OAuth 2.1) and treat clients as authenticated principals, keeping the agentId scheme for intra-principal correlation.

### Registry vs opaque

- The agentId string is **canonical and self-describing** — no registry lookup is ever required to understand a row.
- Minsky MAY maintain an optional `agents` table: `{agent_id, kind, first_seen, last_seen, display_name?}` — purely for UI enrichment (e.g., "show me all agents that touched this module in the last week"). Not for auth decisions. Not load-bearing.

## What this position buys us

- **Ships today.** Layer 1 (ascribed) and Layer 2 (declared via `_meta`) work immediately with the instrumentation already in session. Layer 3 (hook) is a separate but scoped implementation task.
- **Solves the sub-agent problem.** Minsky-dispatched subagents get correct parent chains at dispatch (Layer 2 set by Minsky directly). Claude Code's Task-tool subagent remains a gap until #32514 lands — documented as such, not papered over.
- **Forward-compatible with standards.** Reverse-domain kinds align with SEP-1289. `_meta` carrier aligns with Langfuse and future SEP proposals. Nothing precludes adding JWT verification or DIDs later.
- **Solves the non-MCP channel.** The `github-app:` branch handles Copilot, Linear, and any future git-channel agent cleanly, orthogonal to the MCP-channel branch.
- **Respects Minsky's design philosophy.** Enforcement via hook (Layer 3) is the direct application of environmental pre-delegation. Identity is not a thing we hope the agent remembers to declare; it's a thing the environment ensures is always present.

## What this position costs us

- **No cryptographic verification today.** A malicious caller could forge an agentId in `_meta`. For single-user Minsky this is moot; for future multi-user Minsky this is the first upgrade.
- **Three layers = three code paths.** More complexity than "trust the JWT" or "ignore the problem." But each layer is optional — a caller can use just one, or none (falling to Layer 1 ascribed).
- **Hook infrastructure is Claude-Code-specific.** Other harnesses don't get Layer 3 enforcement today; they fall to Layer 2 if they cooperate, or Layer 1 otherwise. The Minsky rules pipeline could compile equivalent hooks for Codex / Cursor / etc. as those harnesses stabilize their hook APIs — but that's future work, not mt#953.
- **Subagent parent chain depends on caller cooperation for Claude Code.** Until #32514 lands, a Claude Code Task-tool subagent's MCP call is indistinguishable from its parent's at the transport layer. We document this; we don't pretend to fix it.

## Open decisions for the ADR (Phase 5)

1. **Should Layer 3 (the CC hook) ship as part of this ADR's follow-up implementation task, or be deferred?** Argument for ship: closes the main-agent identity gap on Claude Code today. Argument for defer: the hook is a separable concern; we can ship Layers 1+2 first and layer the hook in next.

2. **Should Minsky maintain the optional `agents` registry?** If yes, schema? If no, agentId strings are pure; readers must parse them.

3. **Normalization table for `clientInfo.name` → reverse-domain kind.** Where does this live? Probably `src/domain/agent-identity/kind-normalization.ts` with a config-overridable map.

4. **`_meta` key name.** `io.minsky/agent_id` and `io.minsky/parent_agent_id` follow the MCP conventions for extension keys. Confirm no collision.

5. **How to plumb agentId through Minsky's tool handlers to the session record update path.** A `currentAgentId()` helper that reads from Layer 3 / 2 / 1 in order. Plumbing decision; doesn't affect format.

## References

- [MCP Authorization spec (draft)](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCP SEP-1289 — Client Identity Verification](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289)
- [Claude Code #32514 — Agent identity context for MCP tool calls](https://github.com/anthropics/claude-code/issues/32514)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [A2A protocol](https://github.com/a2aproject/A2A) / [Google announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [Langfuse MCP tracing via `_meta` + W3C Trace Context](https://langfuse.com/docs/observability/features/mcp-tracing)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [arXiv 2511.02841 — AI Agents with DIDs and VCs](https://arxiv.org/abs/2511.02841)
- [Permit.io — Ultimate Guide to MCP Auth](https://www.permit.io/blog/the-ultimate-guide-to-mcp-auth)
- [Cloudflare Mesh announcement](https://www.cloudflare.com/press/press-releases/2026/cloudflare-launches-mesh-to-secure-the-ai-agent-lifecycle/)
- [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
- [CyberArk — Zero Trust for AI Agents](https://developer.cyberark.com/blog/zero-trust-for-ai-agents-delegation-identity-and-access-control/)
- [Cerbos — MCP and Zero Trust](https://www.cerbos.dev/blog/mcp-and-zero-trust-securing-ai-agents-with-identity-and-policy)
- [WorkOS — CIMD (Client ID Metadata Documents)](https://workos.com/blog/client-id-metadata-documents-cimd-oauth-client-registration-mcp)
- [ISACA — The Looming Authorization Crisis](https://www.isaca.org/resources/news-and-trends/industry-news/2025/the-looming-authorization-crisis-why-traditional-iam-fails-agentic-ai)
