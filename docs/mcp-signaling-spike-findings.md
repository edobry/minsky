# MCP Signaling Spike Findings — mt#1315

> **Status:** Infrastructure landed; observation steps not yet performed.
> This skeleton is ready to receive empirical evidence from interactive observation.
> See "How to run" for setup instructions.

---

## How to run

### Prerequisites

- Bun installed (`bun --version`)
- Session workspace checked out locally (or cloned from PR branch)

### Start the spike server (stdio)

```bash
bun run scripts/spike-mcp-signals.ts --transport=stdio
```

### Start the spike server (HTTP)

```bash
bun run scripts/spike-mcp-signals.ts --transport=http --port=39115
```

The HTTP server URL will be printed on startup:

```
MCP server running at: http://localhost:39115/mcp
```

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
Tail it during observation:

```bash
tail -f /tmp/spike-mcp-signals.log | jq .
```

---

## Question 1: Does Claude Code render `notifications/message` from connected servers?

> **Quoted question from spec:** "Does Claude Code's `/mcp` UI render `notifications/message` from connected servers? At what severity levels (debug/info/notice/warning/error/critical/alert/emergency)? Where do they appear (server detail panel, chat stream, status indicator)? Are they persisted across `/mcp` invocations?"

### Empirical evidence

_[ To be filled in after interactive observation. ]_

_Suggested capture procedure:_

1. Call `emit_log` with `level="debug"` and note any UI change.
2. Repeat for each of: `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.
3. After each call, open and close `/mcp` — note whether the log appears there.
4. Note whether the log appears in the chat stream (not just `/mcp`).
5. Screenshot or quote any rendered text verbatim.

### Verdict

_[ One sentence conclusion — e.g. "Claude Code renders notifications/message at warning+ in the chat stream but not in the /mcp panel." ]_

---

## Question 2: What does Claude Code do when the stdio server exits?

> **Quoted question from spec:** "On stdio transport, what does Claude Code do when the server exits? Clean 'server exited' surface in `/mcp`? Generic transport error on next tool call? Auto-restart attempt (docs say no, but verify)? Does the user see the exit at all without explicitly opening `/mcp`?"

### Empirical evidence

_[ To be filled in after interactive observation. ]_

_Suggested capture procedure:_

1. With the spike server running, call `exit_server` (default 250ms delay).
2. Note any immediate UI change (toast, badge, chat message).
3. Open `/mcp` — what does the server status indicator show?
4. Attempt to call `echo` — what error (if any) is returned?
5. Wait 30 seconds — does Claude Code attempt an auto-restart?
6. Restart the server manually and reconnect via `/mcp` — does it reconnect?

### Verdict

_[ One sentence conclusion. ]_

---

## Question 3: Visual states in `/mcp` — pending / failed / needs-auth / connected

> **Quoted question from spec:** "Does `/mcp` distinguish 'pending' / 'failed' / 'needs-auth' / 'connected' visually, and where would staleness land in that taxonomy if reported via different channels?"

### Empirical evidence

_[ To be filled in after interactive observation. ]_

_Suggested capture procedure:_

1. Open `/mcp` before any server is wired in — screenshot baseline.
2. Restart Claude Code with spike server wired in — screenshot "connected" state.
3. Call `exit_server` then open `/mcp` immediately — screenshot "failed/disconnected" state.
4. Note the exact text label, icon, and color for each state.
5. If there is a "pending" state, capture it during server startup (may require slow startup).

### Verdict

_[ One sentence conclusion. ]_

---

## Question 4: Does `InitializeResult.instructions` appear in any UI surface?

> **Quoted question from spec:** "Does the `InitializeResult.instructions` field show up in any UI surface (server detail panel, hover, debug pane)? Or is it strictly model-context only with no human-visible artifact?"

The spike server sets instructions to:

```
[SPIKE-MARKER-1315] This is the spike server for mt#1315. If you can read this in any UI surface — chat stream, /mcp panel, hover text, model context window — please note the exact location and format in docs/mcp-signaling-spike-findings.md.
```

### Empirical evidence

_[ To be filled in after interactive observation. ]_

_Suggested capture procedure:_

1. Open `/mcp` server detail panel — look for the instructions text or `[SPIKE-MARKER-1315]`.
2. Hover over the server name — any tooltip?
3. Ask Claude: "What instructions were provided by the spike-mcp-signals MCP server?" — does it quote the marker?
4. Search the Claude Code debug pane or any visible context dump for the marker string.

### Verdict

_[ One sentence conclusion — e.g. "instructions is model-context only; not displayed in any human-visible UI surface." ]_

---

## Question 5 (Bonus): Logger field and setLevel filtering

> **Quoted question from spec:** "Does Claude Code show server-emitted log messages differently if `logger` field is set vs. unset? Does it filter on `logging/setLevel` correctly?"

The spike server always sends `logger: "spike"` in `notifications/message` payloads.

### Empirical evidence

_[ To be filled in after interactive observation. ]_

_Suggested capture procedure:_

1. Call `emit_log` with `level="debug"` and note if it renders.
2. If Claude Code exposes a way to set log level (via `/mcp` or a command), set it to `warning`.
3. Re-call `emit_log` with `level="debug"` — does it disappear?
4. Call `emit_log` with `level="warning"` — does it appear despite the filter?
5. Compare rendering when `logger: "spike"` vs. without a logger field (would require server modification).

### Verdict

_[ One sentence conclusion. ]_

---

## Recommendation

_[ To be filled in after all observation steps are complete. ]_

**Decision: recommended stdio runtime path for staleness notification**

The four candidate paths from the mt#1315 spec:

| Path                         | Description                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `notifications/message`-only | Emit a log notification at an appropriate level; rely on Claude Code rendering it.         |
| `exit-only`                  | Exit the stdio process when staleness is detected; rely on the transport-error surface.    |
| `exit-plus-message`          | Emit a log notification, then exit.                                                        |
| `elicitation-once-then-exit` | Send an elicitation request once (prompting the user), then exit on timeout or acceptance. |

**Chosen path:** _[ Fill in one of the four options above. ]_

**Rationale:**

_[ At least two sentences grounded in the empirical findings above. E.g.: "notifications/message at warning level is rendered in the chat stream in real-time (Q1 finding), making it the least disruptive channel — the user sees the banner without a session-interrupting exit. Exit-only (Q2 finding) causes a hard tool-failure on the next call with no human-readable context, which is worse UX." ]_

---

## Appendix: Observation session metadata

| Field                | Value                                    |
| -------------------- | ---------------------------------------- |
| Claude Code version  | _[ Fill in: `claude --version` output ]_ |
| Observation date     | _[ Fill in ]_                            |
| Transport tested     | stdio, HTTP                              |
| Sidecar log location | `/tmp/spike-mcp-signals.log`             |
| Screenshot location  | _[ Fill in: directory or issue link ]_   |
