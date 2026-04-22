# mt#953 — Phase 2: Ecosystem and Prior-Art Survey

**Status:** In progress. Initial sweep complete; verification captures for clients other than Claude Code still pending.

## Goal

Determine whether the ecosystem has converged on an agent-identity pattern Minsky can adopt, a draft standard we should track, or nothing useful — so we don't invent in isolation.

## Is this a live question in the community?

**Yes.** Three independent signals:

1. **MCP spec has an active draft proposal** for client identity verification (SEP-1289, see below).
2. **Cloudflare and GitHub are building agent identity systems** — referenced in recent writing as an ecosystem inflection point ([dev.to article](https://dev.to/adioof/cloudflare-and-github-are-building-identity-systems-for-ai-agents-were-not-ready-for-this-7ff)).
3. **AI agents on GitHub get `[bot]`-suffixed identities** as a de facto convention, with documented patterns for setting up distinct commit authorship per agent ([justin.poehnelt.com](https://justin.poehnelt.com/posts/agent-identity-git-commits/), [dev.to / agent_paaru](https://dev.to/agent_paaru/each-ai-agent-gets-its-own-github-identity-how-we-gave-every-bot-its-own-bot-commit-signature-1197)).

## What's standardized

**Nothing yet for MCP.** The current MCP spec (draft 2026) mandates `clientInfo: { name, version }` at initialize and standardizes `_meta.progressToken`, but does not define any client identity primitive. Transport-layer `Mcp-Session-Id` is a session correlation mechanism, not a client identity mechanism.

**GitHub commit authorship** is the closest thing to a standard for non-MCP coding agents — every agent-that-makes-commits ends up with a GitHub account (frequently a `[bot]` App user), a commit email (`slug[bot]@users.noreply.github.com`), and a stable user ID retrievable via the GitHub API.

## What's emerging (to track)

### SEP-1289 — MCP client identity verification

Active draft proposal ([modelcontextprotocol/modelcontextprotocol#1289](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289)). **Status: dormant, "proposal without a sponsor."** Not safe to depend on.

**Proposed fields:**

- `clientId` — reverse-domain identifier, e.g. `com.claude.desktop`, `org.example.debugger.beta`. Format: `domain.vendor.application[.variant]`.
- `clientAuth` — short-lived (≤5 min) JWT with `sub=clientId`, optional `client_version`, `features`, `jti`.
- Server response: `client_verified` boolean, `verification_details` with method (`dns_txt`, `well-known`, etc.).

**Minsky implication:** Even if SEP-1289 never ships, its **reverse-domain format for kind identification** is a good convention to align with — makes Minsky's `agentId` format forward-compatible if SEP-1289 (or a successor) eventually lands.

### SEP-1299 — Server-side authorization management with client session binding

Companion proposal ([modelcontextprotocol/modelcontextprotocol#1299](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1299)). Also draft. Less directly relevant but establishes that "binding auth to client sessions" is on the roadmap.

### Agent Client Protocol (ACP)

Separate protocol from MCP, primarily used by Zed and Kiro for connecting editors to external agents ([agentclientprotocol.com](https://agentclientprotocol.com), [zed.dev/acp](https://zed.dev/acp)).

- Defines `new_session` returning `{ session_id, modes, models }` — explicit session identity at the protocol level (unlike MCP)
- Target audience is editors integrating with agents, not agents speaking to tool servers
- Not directly relevant for Minsky unless Minsky becomes an ACP server, but worth knowing as prior art for protocol-level session identity

### Anthropic's Claude Code

- `CLAUDE_SESSION_ID` env var feature request filed ([anthropics/claude-code#25642](https://github.com/anthropics/claude-code/issues/25642)) — would give Minsky a direct instance ID if it ships
- Agent SDK (`/v1/agents`, `/v1/sessions`) provides session resumption ([platform.claude.com docs](https://platform.claude.com/docs/en/agent-sdk/sessions)) but session IDs are Anthropic-side, only accessible to code running against the SDK directly, not to MCP servers the agent calls
- Current exposed env vars: `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_EXECPATH=...` — sufficient for harness-kind identification only

### OpenAI Codex

- Explicitly documents setting `clientInfo.name` — values like `codex_vscode`, `codex-tui` — and uses it as the compliance-logging anchor ([developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp))
- Strong ecosystem precedent: **`clientInfo.name` is the right key for harness-kind identification**, treated as the published interface by at least one major vendor

## What's ad-hoc per vendor

### MCP clients beyond Claude Code / Codex

**Cursor, Windsurf, Cline, Zed:** no public documentation of their `clientInfo.name` values, their conversation ID handling, or any agent identity mechanism. They all speak MCP as clients but don't (publicly) expose anything that would identify the specific conversation to a called MCP server. Verification requires empirical capture (Phase 1 work).

### Non-MCP coding agents reaching Minsky via git + GitHub

These agents don't hit Minsky's MCP server at all. They push commits, open PRs, or create issues — and identity flows through **GitHub bot identity**:

| Agent                       | GitHub identity                                                                                                                  | Notes                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GitHub Copilot coding agent | `copilot-swe-agent` login; commits authored by `GitHub Copilot` with human as co-author; session link included in commit message | First result when querying `copilot-swe-agent` |
| Linear agent                | GitHub App bot user (varies per install); `{slug}[bot]@users.noreply.github.com` email pattern                                   | Can query `/users/{slug}[bot]` for ID          |
| Any GitHub App-based agent  | Same `[bot]` convention                                                                                                          | Bot user ID != App ID                          |
| GitHub Actions              | `github-actions[bot]`, user ID `41898282`                                                                                        | Well-documented example                        |

**Minsky implication:** the `agentId` scheme needs a branch for **git-channel callers** that's distinct from the MCP-channel branch. Candidate format: `github-app:<slug>` or `github-user:<login>`. This branch is populated when Minsky observes mutations via git provenance (commit author, PR author) rather than MCP.

## Infrastructure analogs worth noting

Not for direct adoption, but useful reference points for the namespace design:

- **GitHub Actions runner identity** — run ID + runner name. Simple, scoped, per-execution. Analogous to what Minsky needs for remote triggers.
- **SPIFFE / SPIRE** (service mesh identity) — overkill for single-user Minsky, but demonstrates the value of hierarchical namespaces (`spiffe://<trust-domain>/<path>`). Minsky's `{kind}:{scope}:{id}` sketch is structurally similar.
- **W3C trace-context** (`traceparent` in `_meta`) — per-request correlation, not session identity, but shows that `_meta` is an accepted carrier for infra-level identifiers.

## Verdict: adopt or invent?

**Hybrid.** Minsky must invent its own `agentId` format, but should align with emerging conventions:

1. **Key harness-kind on `clientInfo.name`** — aligns with Codex's published precedent and the common interface every MCP client already provides.
2. **Use reverse-domain style for the `kind` field** when expanding — forward-compatible with SEP-1289 if it ever ships. Example: `com.anthropic.claude-code` rather than just `cc`.
3. **Keep a parallel `github-app:<slug>` branch** for non-MCP (git-channel) callers — aligned with the de-facto GitHub bot-user convention.
4. **Don't block on any draft spec** — SEP-1289 is dormant, Anthropic's `CLAUDE_SESSION_ID` is a feature request, ACP is orthogonal. Minsky ships a working scheme now, with extension points for when/if standards land.

## Practical format proposal (feeds Phase 4 + Phase 5 ADR)

```
kind:scope:id[@parent-agentId]
```

With mapping:

- `kind` — reverse-domain, e.g. `com.anthropic.claude-code`, `com.openai.codex`, `com.cursor`, `app.zed`, `minsky.native-subagent`, `github-app`, `unknown`
- `scope` — how `id` is scoped: `conv` (conversation/session UUID), `run` (execution run), `proc` (server process), `inst` (installation)
- `id` — the unique value within that scope
- `@parent-agentId` — optional; for nested agents (Task-tool subagent, Minsky native subagents)

Examples:

- `com.anthropic.claude-code:proc:{pid}@{host-hash}` — Claude Code today, fallback because conversation UUID isn't exposed
- `com.anthropic.claude-code:conv:{uuid}` — Claude Code once `CLAUDE_SESSION_ID` ships
- `com.anthropic.claude-code:conv:{uuid}/task:{id}` — Task-tool subagent
- `com.openai.codex:tui:{proc-hash}` — Codex TUI instance
- `com.anthropic.triggers:run:{run-id}` — Anthropic remote trigger
- `github-app:copilot-swe-agent:install:{installation-id}` — Copilot coding agent
- `github-app:{linear-slug}:install:{installation-id}` — Linear agent
- `minsky.native-subagent:{task-id}@{parent}` — Minsky subagent (mt#441)
- `unknown:hash:{sha256(host,user,pid,start)}` — fallback

Format decisions still pending Phase 4 (capture point, history vs current, privacy of host info, registry shape).

## References

- [SEP-1289 — Client Identity Verification in MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289)
- [SEP-1299 — Server-Side Authorization Management](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1299)
- [Agent Client Protocol (ACP) — Session Setup](https://agentclientprotocol.com/protocol/session-setup)
- [Zed ACP implementation](https://zed.dev/acp)
- [CLAUDE_SESSION_ID feature request](https://github.com/anthropics/claude-code/issues/25642)
- [OpenAI Codex MCP docs](https://developers.openai.com/codex/mcp)
- [Claude Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Agent Identity for Git Commits (J. Poehnelt)](https://justin.poehnelt.com/posts/agent-identity-git-commits/)
- [Each AI Agent Gets Its Own GitHub Identity (dev.to)](https://dev.to/agent_paaru/each-ai-agent-gets-its-own-github-identity-how-we-gave-every-bot-its-own-bot-commit-signature-1197)
- [Cloudflare and GitHub are building identity systems for AI agents (dev.to)](https://dev.to/adioof/cloudflare-and-github-are-building-identity-systems-for-ai-agents-were-not-ready-for-this-7ff)
- [GitHub Copilot coding agent docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
