# mt#953 — Phase 1: MCP Signal Inventory (Empirical)

**Status:** In progress. Populated with signals confirmed by direct observation and a live capture against a real Claude Code invocation.

**Companion analysis:** [Notion — Analysis: The authority of agent identity](https://www.notion.so/34a937f03cb48143bfbedd8710972daf) — the synthesis of what these signals mean, organized by authority (ascribed / declared / enforced), with Minsky's position.

## Goal

Determine from observation — not documentation — what identity information reaches the Minsky MCP server from real callers. Output is the matrix that shapes the ADR's format decisions.

## What signals exist, classified by layer

Identity signals available to an MCP server live at four layers, each with different availability guarantees. The design must pick signals that are _actually present_ in the observed envelope, not ones that specs say _may_ be present.

### Layer A — Process / environment (always present on stdio)

When a caller spawns Minsky as a stdio MCP server subprocess, the server inherits the caller's process environment. This is the richest source of harness-kind signals in practice.

**Confirmed via direct observation** (Claude Code desktop on macOS, version 2.1.117, both interactive and headless):

```
CLAUDECODE=1
CLAUDE_CODE_ENTRYPOINT=cli          # interactive invocation
CLAUDE_CODE_ENTRYPOINT=sdk-cli      # headless `claude -p` invocation — distinguishable
CLAUDE_CODE_EXECPATH=/opt/homebrew/Caskroom/claude-code@latest/2.1.117/claude
CLAUDE_CODE_SUBAGENT_MODEL=sonnet
```

`CLAUDE_CODE_ENTRYPOINT` varying between `cli` and `sdk-cli` is itself a useful signal — a Minsky MCP server can distinguish "user is driving interactively" from "this server was launched by an SDK-based headless invocation" without further protocol work.

**Load-bearing negative results:**

- **No `CLAUDE_SESSION_ID`** is set. An open feature request ([anthropics/claude-code#25642](https://github.com/anthropics/claude-code/issues/25642)) proposes this env var but it has not shipped as of Claude Code 2.1.116.
- **No conversation UUID is exposed** via any env var. This means Claude Code callers — main agent and Task-tool subagents alike — cannot be distinguished from env alone at the instance level. Only the harness kind is identifiable.

**Server-side process context** (always observable from within the server):

- PID, PPID, start time, hostname, user, TTY
- Parent command line (via `ps -o command= -p $PPID` or `/proc/$PPID/cmdline` on Linux)

On stdio, server-side PID + start-time uniquely tags the transport connection. That is not the same as tagging the _conversation_ — Claude Code may reuse a server subprocess across turns but typically spawns a fresh one per tab. Empirical verification required per caller.

### Layer A.5 — Claude Code hook stdin (separate signal channel)

Claude Code PreToolUse / PostToolUse / SessionStart hooks receive JSON on stdin that includes `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and for tool hooks `tool_name`, `tool_input`, `tool_use_id` (per [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)).

**This means:** a Minsky-supplied hook CAN access the Claude Code conversation's `session_id` even though the MCP server cannot. This is the foundation for Layer 3 (enforced) identity in the companion analysis doc — the hook reads `session_id` and injects it into the outgoing MCP tool call's `_meta`, making the conversation ID observable at the server.

This is a separate signal channel from MCP itself, available only for Claude Code callers (other harnesses would need analogous hook mechanisms).

### Layer B — MCP `initialize` request (always sent, content varies)

Per MCP spec, every client sends `initialize` with `params.clientInfo: { name, version }` plus `capabilities` and `protocolVersion`. The server SDK exposes these after init via `server.getClientVersion()` and `server.getClientCapabilities()`.

**Confirmed via live capture** (fixture: `docs/research/fixtures/mt953-claude-code-2.1.117-capture.jsonl`):

Claude Code 2.1.117 sends an **extended `clientInfo`** beyond the spec's `{name, version}`:

```json
"clientVersion": {
  "name": "claude-code",
  "title": "Claude Code",
  "version": "2.1.117",
  "websiteUrl": "https://claude.com/claude-code",
  "description": "Anthropic's agentic coding tool"
}
```

Note: `clientInfo.name = "claude-code"` — **not** `"claude-ai"` as older web examples suggested. This contradicts some third-party docs and is the correct identifier to key on.

Claude Code's advertised **capabilities**:

```json
"clientCapabilities": {
  "elicitation": { "form": {} },
  "roots": {}
}
```

Useful to know — Claude Code supports MCP elicitation (server can prompt the user for input mid-tool-call) and roots (server can query filesystem root paths the client wants exposed).

**Confirmed `clientInfo.name` values across harnesses:**

| Harness                          | `clientInfo.name` | Source                            |
| -------------------------------- | ----------------- | --------------------------------- |
| Claude Code desktop/CLI          | `claude-code`     | Live capture, Claude Code 2.1.117 |
| OpenAI Codex (TUI)               | `codex-tui`       | OpenAI docs                       |
| OpenAI Codex (VS Code extension) | `codex_vscode`    | OpenAI docs                       |

Cursor, Windsurf, Cline, Zed: `clientInfo.name` not verified yet; Phase 1 captures pending.

### Layer C — Transport session ID (HTTP only)

In HTTP/SSE transport, the MCP server SDK generates a `Mcp-Session-Id` header (UUID) and returns it to the client. The client must include it in subsequent requests. Minsky's current HTTP transport (`src/mcp/server.ts` `handleHttpPost`) already uses this pattern — `transport.sessionId` is populated and stored in `httpTransports: Map<string, StreamableHTTPServerTransport>`.

In the MCP SDK, `RequestHandlerExtra.sessionId?: string` carries this value to tool handlers for HTTP connections.

**Important:** this is a _transport_ session, not a _conversation_. A client that reconnects (new HTTP session) gets a new sessionId — so this is good for "this connection" but not for "this conversation" unless the client persists and reuses sessionIds.

On stdio transport, `RequestHandlerExtra.sessionId` is always `undefined`. Stdio's "session" is the lifetime of the server subprocess.

### Layer D — Per-request metadata (`_meta`)

MCP standardizes `params._meta` as a place for per-request metadata. Currently defined uses:

- `progressToken` — correlation ID for streaming progress updates (must be unique within active requests)
- `io.modelcontextprotocol/related-task.taskId` — SDK-level task correlation (unrelated to Minsky tasks)

`_meta` also holds W3C trace-context propagation fields (`traceparent`, `tracestate`) when the client opts to send them. These are request-level correlation, not session-level — but in principle a harness could put a stable conversation ID into a custom `_meta` key.

**Draft ecosystem proposal** — SEP-1289 ([modelcontextprotocol/modelcontextprotocol#1289](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289)) proposes adding `clientId` (reverse-domain, e.g. `com.claude.desktop`) and `clientAuth` (short-lived JWT) to the initialize request. Status: dormant, no sponsor. Not safe to rely on.

## Capture scenarios — status

| #   | Scenario                               | Env captured?    | clientInfo captured? | Transport | Notes                                                                           |
| --- | -------------------------------------- | ---------------- | -------------------- | --------- | ------------------------------------------------------------------------------- |
| 1   | Claude Code desktop, single tab        | YES              | YES (live fixture)   | stdio     | `clientInfo.name="claude-code"`, version 2.1.117, extended fields confirmed     |
| 2   | Claude Code desktop, tab B (parallel)  | —                | —                    | stdio     | pending; expected identical Layer A/B, different Layer C/process                |
| 3   | Claude Code desktop, different machine | —                | —                    | stdio     | pending; differs at hostname                                                    |
| 4   | Claude Code Web                        | —                | —                    | ?         | pending; does it speak MCP at all?                                              |
| 5   | Anthropic remote trigger               | —                | —                    | ?         | pending; run ID surface unknown                                                 |
| 6   | Codex CLI                              | —                | —                    | stdio     | expected `clientInfo.name="codex-tui"`                                          |
| 7   | Cursor / Windsurf / Cline / Zed        | —                | —                    | mixed     | pending; `clientInfo.name` values unverified                                    |
| 8   | GitHub Copilot coding agent            | n/a (via GitHub) | n/a                  | n/a       | identity flows through commit author = `copilot-swe-agent` + GitHub App install |
| 9   | Linear agent                           | n/a (via GitHub) | n/a                  | n/a       | identity via GitHub App bot user `{slug}[bot]` + user ID                        |
| 10  | Claude Code Task-tool subagent         | —                | —                    | stdio     | pending; expected indistinguishable from main at MCP layer                      |

## Key preliminary conclusions

1. **Harness kind is universally identifiable.** Either Layer A (env vars like `CLAUDECODE=1`) or Layer B (`clientInfo.name`) always tells us which harness. A well-designed scheme keys on both with env-var override.

2. **Instance identity is NOT universally identifiable.** For Claude Code today, there is no stable conversation UUID available to an MCP server. Until `CLAUDE_SESSION_ID` ships (if it does), Minsky must either:

   - Fall back to server-process signals (PID + start time + hostname) on stdio, acknowledging that tagging is per-connection not per-conversation
   - Or: ask Claude Code to pass a conversation ID via `_meta` on each tool call (requires harness cooperation; no current mechanism)

3. **Transport mode substantially changes what's knowable.** Stdio gives us env + server PID; HTTP gives us `Mcp-Session-Id` but not env. Minsky's MCP server supports both — the scheme must work for both.

4. **Non-MCP callers are a separate channel.** Copilot and Linear agents don't reach Minsky via MCP at all; their identity flows through git commit author + GitHub App installation IDs. The agent identity scheme must cover git-channel callers explicitly, possibly as a parallel `kind:github-app:<slug>` branch.

5. **`clientInfo.name` is the de-facto harness-kind anchor.** Codex documents it explicitly; Claude Code uses `claude-ai`. Cursor/Windsurf/Cline will almost certainly follow the same pattern. Minsky should standardize on mapping `clientInfo.name` to a normalized `kind` field.

## Reproducing captures

Instrumentation is tracked separately (see `src/mcp/diagnostic-capture.ts` — in progress). The env-var capture shown in this doc was reproduced via:

```bash
env | grep -iE '^(claude|anthropic|cursor|windsurf|codex|cline|zed|mcp|copilot)' | sort
```

run from a Bash tool call inside a Claude Code conversation. Because Claude Code spawns children (Bash, MCP servers) with the same inherited environment, this captures what a Minsky MCP server would see as its env.

## Open questions (driving remaining Phase 1 work)

- What does `clientInfo.name` actually equal for Cursor, Windsurf, Cline, Zed? (capture needed)
- Does Claude Code Web speak MCP, and if so over what transport? (investigation needed)
- What envelope does an Anthropic remote trigger produce — any run ID in env or `_meta`? (capture needed — requires running Minsky inside a trigger)
- Does a Claude Code Task-tool subagent's MCP call differ in any envelope field from its parent? (capture comparison needed)
- What PID / process-tree pattern uniquely tags tab A vs tab B when both connect to the same long-running Minsky MCP server (if such a config exists)? Typically Claude Code spawns fresh MCP server per tab, making this a non-issue — but worth verifying empirically.

## References

- MCP spec (current draft): https://modelcontextprotocol.io/specification/draft/schema
- MCP SDK server types: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts`
- MCP SDK protocol types: `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts` (`RequestHandlerExtra`)
- SEP-1289 client identity proposal: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1289
- `CLAUDE_SESSION_ID` feature request: https://github.com/anthropics/claude-code/issues/25642
- Codex MCP clientInfo docs: https://developers.openai.com/codex/mcp
- Minsky MCP server: `src/mcp/server.ts`
