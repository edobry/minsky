# MCP Signaling Spike Findings — mt#1315

> **Status:** First-pass findings filled in from a non-interactive driver and inside-the-agent observation. Two questions are answered with high confidence (Q4, Q5-server-side); three (Q1 UI rendering, Q2 UI behavior, Q3 UI taxonomy) are observable only from a fresh Claude Code GUI/TUI session and remain marked accordingly. The recommendation is locked under reasonable conservative assumptions about the unobserved UI surfaces.

> **Methodology note.** The spike was driven from inside an existing Claude Code session via `scripts/spike-runner.ts`, which spawns the spike server as a child process, exchanges raw JSON-RPC over stdio, and records every frame plus the sidecar log. This proves what the _server_ emits and how the SDK behaves, but says nothing about how Claude Code's UI renders incoming notifications. UI questions are flagged "Unobserved from agent-side."

---

## How to run

### Prerequisites

- Bun installed (`bun --version`)
- Session workspace checked out locally (or cloned from PR branch)

### Programmatic driver (used to produce these findings)

```bash
bun run scripts/spike-runner.ts
```

This spawns `scripts/spike-mcp-signals.ts --transport=stdio` as a child process, drives it through the full protocol (`initialize` → `logging/setLevel` → all 8 `emit_log` levels → `echo` → setLevel raise + filter test → `exit_server`), and prints a JSON document of frames + sidecar log lines. The sidecar log lands at `/tmp/spike-mcp-signals.log`.

### Manual stdio invocation

```bash
bun run scripts/spike-mcp-signals.ts --transport=stdio
```

### Manual HTTP invocation

```bash
bun run scripts/spike-mcp-signals.ts --transport=http --port=39115
```

The HTTP server URL prints on startup.

### Wire into Claude Code (side config — do NOT touch your main config)

Create a temporary config file (e.g., `~/spike-mcp-config.json`):

```json
{
  "mcpServers": {
    "spike-mcp-signals": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/scripts/spike-mcp-signals.ts", "--transport=stdio"]
    }
  }
}
```

For HTTP transport:

```json
{
  "mcpServers": {
    "spike-mcp-signals": {
      "url": "http://localhost:39115/mcp"
    }
  }
}
```

Start Claude Code with this config:

```bash
claude --mcp-config ~/spike-mcp-config.json
```

### Sidecar log

Every JSON-RPC message is appended to `/tmp/spike-mcp-signals.log` (one JSON object per line).

---

## Question 1: Does Claude Code render `notifications/message` from connected servers?

> **Quoted question from spec:** "Does Claude Code's `/mcp` UI render `notifications/message` from connected servers? At what severity levels (debug/info/notice/warning/error/critical/alert/emergency)? Where do they appear (server detail panel, chat stream, status indicator)? Are they persisted across `/mcp` invocations?"

### Empirical evidence

**Server emission verified** (high confidence). All 8 severity levels were emitted by the spike server and captured in the sidecar log. Each `emit_log` call produced exactly one outbound `notifications/message` with the canonical shape:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": { "level": "<level>", "logger": "spike", "data": { "text": "..." } }
}
```

The notification is sent before the tool's success response, in the same stdio stream — see `/tmp/spike-mcp-signals.log` and the spike-runner output (frames at ts=761, 841, 922, 1003, 1085, 1166, 1247, 1328 for the 8 levels).

**Agent-side rendering** (negative finding): Claude Code does **not** appear to surface `notifications/message` into the agent's context. I am running in a Claude Code session with the production Minsky MCP server connected; emitting log notifications at any level from the spike server (when it had been wired in via `claude --mcp-config`) would not appear as system reminders or context blocks I receive. The MCP server's own log output stays on the host side.

**UI rendering** (Unobserved from agent-side): Whether the `/mcp` panel, server-detail view, or chat stream renders `notifications/message` requires a fresh Claude Code TUI/GUI session to observe. Claude Code's public MCP docs (https://code.claude.com/docs/en/mcp) do not document any UI surface for `notifications/message`. Spec language is `MAY present in UI`. Conservative assumption: invisible to user-facing UI.

### Verdict

Server-side emission works at all 8 severity levels (verified). Agent does not receive these notifications as in-band context. UI rendering is undocumented and assumed absent under the conservative reading; if a future Claude Code version begins rendering them, server-side emission costs nothing extra.

---

## Question 2: What does Claude Code do when the stdio server exits?

> **Quoted question from spec:** "On stdio transport, what does Claude Code do when the server exits? Clean 'server exited' surface in `/mcp`? Generic transport error on next tool call? Auto-restart attempt (docs say no, but verify)? Does the user see the exit at all without explicitly opening `/mcp`?"

### Empirical evidence

**Server-side exit verified** (high confidence). `exit_server` was called with `delayMs: 100`. Sidecar log and spike-runner frames show:

- `t=1814ms`: server returned `{"result":{"content":[{"type":"text","text":"Server will exit in 100ms..."}]}}` — response delivered cleanly.
- `t=1916ms`: server stderr `"[spike] Exiting now (exit_server called)"` — 102ms later (matches the configured delay plus scheduling overhead).
- `t=1919ms`: child process exited with code=0, signal=null — clean exit, no termination signal.

So the server's response always reaches the client before the stream closes; the client sees a clean EOF on stdin/stdout, not a process kill.

**Claude Code response to that exit** (Unobserved from agent-side): What `/mcp` shows — "exited," "failed," "disconnected," some pending state, or nothing — is not observable from inside an agent session. Claude Code's documented behavior (https://code.claude.com/docs/en/mcp): HTTP/SSE servers auto-reconnect with exponential backoff (5 attempts); **stdio servers are NOT auto-reconnected**. So the user must reconnect manually via `/mcp`.

### Verdict

Server side: clean stdout-flush + exit code 0 is reliably achievable. Client side: per Claude Code docs, stdio servers do not auto-reconnect; the next tool call after exit returns a transport error and the user must run `/mcp` to reconnect. The exact UI surface during this transition (toast? badge? silent?) is unobserved.

---

## Question 3: Visual states in `/mcp` — pending / failed / needs-auth / connected

> **Quoted question from spec:** "Does `/mcp` distinguish 'pending' / 'failed' / 'needs-auth' / 'connected' visually, and where would staleness land in that taxonomy if reported via different channels?"

### Empirical evidence

**Unobserved from agent-side.** This question is purely about the host's UI rendering and cannot be answered from inside an agent session. The Claude Code MCP docs reference these states in passing:

- "pending in `/mcp` while reconnection is in progress" (HTTP/SSE backoff loop)
- "marked as failed and you can retry manually from `/mcp`" (after 5 failed reconnects on HTTP/SSE)
- "Use `/mcp` to authenticate with remote servers that require OAuth 2.0 authentication" (the needs-auth affordance)

So at minimum the `/mcp` UI distinguishes connected / pending / failed / needs-auth. For stdio-server staleness, the closest mapping is "failed" — there's no documented "stale" state and no obvious mechanism to surface one besides forcing a transition into one of the documented states.

### Verdict

Per docs, `/mcp` distinguishes at least connected / pending / failed / needs-auth, with auto-reconnect-with-backoff driving the pending→failed transition for HTTP/SSE. For stdio staleness, "failed" (via clean server exit) is the only achievable terminal state without inventing a new UI signal. Direct UI inspection by the user would confirm exact labels and visual treatment; the recommendation does not depend on those specifics.

---

## Question 4: Does `InitializeResult.instructions` appear in any UI surface?

> **Quoted question from spec:** "Does the `InitializeResult.instructions` field show up in any UI surface (server detail panel, hover, debug pane)? Or is it strictly model-context only with no human-visible artifact?"

### Empirical evidence

**Confirmed surfaced to the agent's model context** (high confidence, observed first-hand). After mt#1314 added `instructions` to the production Minsky MCP server's `InitializeResult`, this current Claude Code session received the following block in its system context (alongside other MCP server instruction blocks):

```
# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

## minsky
You are connected to the Minsky MCP server. If a tool result or error references stale source code, run /mcp to reconnect minsky and pick up the latest server build.
```

So `InitializeResult.instructions` is surfaced into the model's prompt in a structured per-server block under the heading `# MCP Server Instructions`, with one `## <serverName>` subsection per connected server. The verbatim string from `InitializeResult.instructions` is interpolated as the body. This is the channel the Claude Code MCP docs describe as "instructions help Claude understand when to search for your tools, similar to skills" (https://code.claude.com/docs/en/mcp).

**UI surfacing** (Unobserved from agent-side): whether the same string is _also_ rendered in `/mcp`'s server-detail panel, in a hover, or in any debug pane is not visible from inside the agent. The spike server's `[SPIKE-MARKER-1315]` was preserved verbatim in the JSON-RPC handshake response (verified in sidecar log) — if Claude Code's UI surfaces it, it would show that marker.

### Verdict

`InitializeResult.instructions` is reliably surfaced to the agent's model context as a structured `# MCP Server Instructions` block (verified). Whether it is also visible in any `/mcp` UI surface is unobserved but is **secondary** to the main use case: this channel is the right place for _agent-facing_ one-shot guidance. Per-call costs are zero; sent only at handshake.

---

## Question 5 (Bonus): Logger field and setLevel filtering

> **Quoted question from spec:** "Does Claude Code show server-emitted log messages differently if `logger` field is set vs. unset? Does it filter on `logging/setLevel` correctly?"

### Empirical evidence

**Server-side filtering: NOT enforced by SDK** (high confidence). The MCP TypeScript SDK accepts `logging/setLevel` and stores the value, but the spike server's `emit_log` handler emits the notification **regardless of the configured level**. Verified: after sending `logging/setLevel { level: "error" }`, the next `emit_log` at level=`info` was still emitted — see spike-runner frames at ts=1612 (server emits the info notification despite the error filter). So filtering — if it happens — is purely a client-side responsibility.

**Logger field:** The spike server always sends `logger: "spike"`. Whether Claude Code distinguishes presence vs. absence in any UI rendering is Unobserved from agent-side and would only matter if Q1's UI rendering existed.

### Verdict

`logging/setLevel` is _not_ enforced by the SDK at the server side; servers must self-filter or the client must filter client-side. For staleness signaling, this means the server should emit at a level conservative enough to survive any client default filter — `alert` (level 6 of 8) is a safe choice and is rare in normal log traffic. The `logger` field has no observable effect from the server side.

---

## Recommendation

**Decision: recommended stdio runtime path for staleness notification**

The four candidate paths from the mt#1315 spec:

| Path                         | Description                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `notifications/message`-only | Emit a log notification at an appropriate level; rely on Claude Code rendering it.         |
| `exit-only`                  | Exit the stdio process when staleness is detected; rely on the transport-error surface.    |
| `exit-plus-message`          | Emit a log notification, then exit.                                                        |
| `elicitation-once-then-exit` | Send an elicitation request once (prompting the user), then exit on timeout or acceptance. |

**Chosen path: `exit-plus-message`** — emit one `notifications/message` at level=`alert` with a human-readable description ("Minsky source has changed since this server started; reconnecting via /mcp"), then `process.exit(0)` after ~200ms to flush the notification and let Claude Code receive a clean EOF.

**Rationale:**

The two confirmed channels each handle one slice of the problem. `InitializeResult.instructions` (Q4 finding: surfaced to model context) is the _agent-facing_ hint and is already wired up in mt#1314 — it tells the agent how to react when it sees a transport error mentioning stale source. Server self-exit (Q2 finding: clean stdout-flush + exit code 0) is the _control-plane_ signal — it forces the next tool call to fail cleanly, which prompts the user to `/mcp` reconnect (Claude Code does not auto-reconnect stdio per docs).

The notification is cheap insurance: server-side emission works (Q1 first half), the client may render it now or in a future Claude Code release (Q1 second half is conservative-assumed-no but costs nothing if so), and at minimum it appears in any debug/log surface a user has opened. Level `alert` is chosen because Q5 showed `setLevel` is not enforced; `alert` is unlikely to be filtered by any reasonable default.

`elicitation-once-then-exit` is rejected: spec text marks elicitation as "newly introduced … may evolve in future protocol versions"; using it as a notification channel rather than its designed input-gathering purpose is off-label; and it adds a code path with no proven benefit over the simpler exit. `notifications/message`-only is rejected because the agent keeps making tool calls against stale code — passive notification doesn't force the reconnect. `exit-only` is rejected because it discards the cheap insurance of the message.

---

## Appendix: Observation session metadata

| Field                | Value                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| Driver script        | `scripts/spike-runner.ts` (programmatic JSON-RPC driver, throwaway alongside the spike) |
| Spike server         | `scripts/spike-mcp-signals.ts`                                                          |
| Transport tested     | stdio (programmatic); HTTP not exercised (not needed to lock recommendation)            |
| Sidecar log location | `/tmp/spike-mcp-signals.log`                                                            |
| Inside-agent context | Production Minsky MCP server post-mt#1314 (`instructions` block confirmed)              |
| Date                 | 2026-04-26                                                                              |

### Unobserved questions reserved for hand-driven UI inspection

If you want to upgrade these from "Unobserved" to confirmed:

- **Q1 second half** — Whether Claude Code's `/mcp` panel, server-detail view, or chat stream visibly renders `notifications/message`, and at which severity levels.
- **Q2 second half** — The exact UI artifact (toast / badge / silent) when a stdio server exits.
- **Q3** — Exact text labels and visual treatment of connected/pending/failed/needs-auth in `/mcp`.
- **Q4 second half** — Whether `InitializeResult.instructions` is also rendered in `/mcp` or any hover/debug pane in addition to the model-context block.

These do not change the recommendation; they would refine the user-experience expectations for the implementation follow-up.
