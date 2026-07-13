# Minsky MCP stdio respawn proxy — architecture

## The problem

Claude Code's MCP integration uses a stateful stdio transport: it spawns the MCP server
as a child process, and the two processes communicate over `stdin`/`stdout`. When the
server process exits — for any reason — Claude Code observes a disconnect and presents
the user with an `/mcp` click to reconnect.

Minsky's staleness-exit mechanism (mt#1322) intentionally exits the inner server after
detecting that its source tree has been updated since the server started. This is the
correct design for keeping the agent's tool set coherent with the merged codebase, but
it surfaces as a visible disconnect in Claude Code every time a PR touching `src/` is
merged.

The root cause is structural: Claude Code's MCP reconnection logic
(`useManageMCPConnections.ts:354–356` in the Claude Code source) does not have an
automatic-reconnect path for server-initiated exits. This has been reported upstream
(issue #43177) and related feature requests have been closed as "not planned" (#56937,
2026-05-07). Waiting for upstream to solve this is not a viable path given the cadence
of Minsky merges.

The problem, restated: the inner Minsky server needs a way to signal Claude Code to
reload its tool list, but Claude Code's stdio transport has no mechanism for that
signal. Every signaling surface that mt#1315 prototyped either produced visible
disconnects, depended on unstable private APIs, or required changes in Claude Code
itself.

## The supervisor-below pattern

The proxy converts an unsolvable problem ("server signals client to restart over stdio")
into a solvable one ("process supervisor catches child exit and respawns below the
visibility boundary").

The key insight: Claude Code has a stable, long-lived connection to the proxy process.
The proxy's stdio never closes — only the inner server's does. From Claude Code's
perspective, the MCP server is always alive. The proxy holds the connection open while
managing the inner server's lifecycle in the subprocess layer, which Claude Code cannot
observe.

This is a well-known supervisor pattern: the supervisor (proxy) presents a stable
endpoint to the consumer (Claude Code) while managing the lifecycle of the worker
(inner Minsky server) below the consumer's visibility boundary. The consumer never sees
restarts unless the supervisor itself exits.

Concretely:

1. Claude Code connects to the proxy over stdio (`minsky mcp proxy`).
2. The proxy spawns `minsky mcp start` as its child.
3. The proxy pipes Claude Code's stdin/stdout through to the child, byte-for-byte.
4. When the child exits (clean staleness exit, crash, or signal), the proxy absorbs
   the exit, tears down the old stdio pipes, and spawns a fresh child.
5. Claude Code's connection to the proxy is unaffected. The tool list is refreshed
   from the new child on the next `tools/list` call.

## Byte-level topology

```
Claude Code
    │  (stdin)
    ▼
┌─────────────────────────────────────┐
│  MinskyStdioProxy (proxy process)  │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  Inbound transform stream   │   │
│  │  (stdin → child.stdin)      │   │
│  │                             │   │
│  │  Intercept:                 │   │
│  │  • tools/call               │   │
│  │    __proxy_restart_server   │   │
│  │    → handle locally         │   │
│  │  • all other frames         │   │
│  │    → pass through verbatim  │   │
│  └──────────────┬──────────────┘   │
│                 │                   │
│                 ▼                   │
│  ┌─────────────────────────────┐   │
│  │  Inner server (child PID)   │◄──┼── respawn on exit
│  │  minsky mcp start           │   │
│  └──────────────┬──────────────┘   │
│                 │                   │
│  ┌──────────────▼──────────────┐   │
│  │  Outbound transform stream  │   │
│  │  (child.stdout → stdout)    │   │
│  │                             │   │
│  │  Intercept:                 │   │
│  │  • tools/list response      │   │
│  │    → augment with           │   │
│  │      __proxy_restart_server │   │
│  │  • __proxy_ready_probe_*    │   │
│  │    response (mt#2011)       │   │
│  │    → swallow + emit         │   │
│  │      tools/list_changed     │   │
│  │  • all other frames         │   │
│  │    → pass through verbatim  │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
    │  (stdout: child responses +
    │   proxy-injected notifications/
    │   tools/list_changed on respawn)
    ▼
Claude Code
```

Paths through the proxy:

- **Normal request/response:** Claude Code writes a JSON-RPC request frame to stdin.
  The inbound transform inspects the line. If it is not a `tools/call` for
  `__proxy_restart_server`, the frame is passed through verbatim to the child's
  stdin. The child processes it and writes a JSON-RPC response frame. The outbound
  transform inspects the line. If it is not a `tools/list` response, the frame is
  passed through verbatim to stdout. Claude Code receives the response.

- **Staleness exit / respawn path:** The inner server calls `process.exit(0)`.
  The child's stdio closes. The proxy's `child.on("close")` fires, classifies the
  exit as `clean_exit`, tears down the old Transform streams, and schedules a respawn
  after `RESPAWN_DELAY_MS` (200 ms). A fresh child is spawned with the same command
  and args. New Transform streams are wired. The proxy's stdin/stdout remain open
  throughout. Claude Code sees no disconnect. After the fresh child confirms
  readiness via the ping probe (see below), the proxy emits
  `notifications/tools/list_changed` so Claude Code refreshes its tools/list
  cache without operator action.

- **Agent-initiated restart (`__proxy_restart_server`):** Claude Code writes a
  `tools/call` JSON-RPC frame with `params.name === "__proxy_restart_server"`. The
  inbound transform detects this, swallows the frame (does not forward to the child),
  and calls `handleProxyRestart()`. The proxy kills the current child (SIGTERM →
  SIGKILL grace), tears down pipes, spawns a fresh child, AWAITS the ping
  readiness probe (semantic ready signal; replaces the prior blanket 300ms
  wait), emits `notifications/tools/list_changed`, then writes the
  `tools/call` success response directly to stdout. Claude Code therefore
  sees notification-then-response, refreshes its tools/list cache, and can
  immediately use the refreshed tool list.

- **Ping readiness probe + tools-list-changed emission (mt#2011):** After
  every successful `spawnChild()` call, the proxy synthesizes a JSON-RPC
  `ping` request with id `__proxy_ready_probe_<spawnCount>` and writes it
  to the fresh child's stdin. Per the MCP spec, `ping` is a transport-layer
  liveness method handled by the SDK's base `Protocol` class without
  requiring prior `initialize`, so the probe works against a child that
  has not seen a client handshake on this respawn. The outbound transform
  recognises the probe response by id prefix and:
  1. Swallows the response (does NOT forward upstream).
  2. On respawns (`spawnCount > 1`), writes
     `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}` to
     `process.stdout` so Claude Code refreshes its tools cache.
  3. On the initial spawn (`spawnCount === 1`), the notification is
     skipped — Claude Code's session-start `initialize` handshake is
     still in flight, and a notification then is premature.
     The probe has a 2-second timeout fallback: if the child does not respond
     in time, the notification is emitted anyway as best-effort (better to
     race the inner's startup than to silently leave the cache stale). The
     reserved `__proxy_ready_probe_` prefix is reserved by the proxy; no
     external client should ever send a request with this prefix.

## `__proxy_restart_server` tool contract

**Name:** `__proxy_restart_server`

**Schema:**

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

No arguments. The tool takes no parameters.

**Semantics:** When called, the proxy kills the current inner server, spawns a fresh
one, and returns a success response with a timestamp. The inner server's full
initialization (including loading the latest source) happens transparently. The next
`tools/list` call from Claude Code will receive the augmented list from the fresh
inner server.

**Visibility:** The tool is injected into every `tools/list` response by the outbound
transform. Claude Code sees it as a regular MCP tool. Agents can call it to force a
reload without triggering a visible disconnect.

**The `__` prefix** is an anti-collision marker. MCP tool names must be valid
identifiers; the double-underscore prefix is a convention for "proxy-layer meta-tool."
The inner Minsky server is expected never to expose a tool with this prefix. If it
does, the proxy logs a warning to stderr and leaves the inner server's version in
place (the injected one is suppressed).

**Scope:** The tool is only visible when Claude Code's config points at `minsky mcp
proxy`. Users running `minsky mcp start` directly do not see it.

## Raw stdio piping — design rationale

The proxy does not re-encode JSON-RPC frames through an MCP SDK transport layer.
Instead, it pipes raw bytes between Claude Code and the inner server, with two narrow
intercept points (one on each direction).

Why raw piping:

1. **Framing-byte-identical.** Every byte that the inner server emits reaches Claude
   Code unchanged (except for the `tools/list` augmentation). There is no risk of
   the proxy introducing framing differences, encoding changes, or schema drift.
   The inner server's output is the ground truth; the proxy is transparent to it.

2. **Disconnect-tracker visibility preserved.** The inner Minsky server's disconnect
   tracker (mt#1645/mt#1682/mt#1705) operates on `process.stdin` close events. Because
   Claude Code talks to the inner server over the raw pipe (not a re-encoded transport),
   the inner server's disconnect tracker sees the same events it would see without the
   proxy. `incrementToolCallCount()` increments on each tool call; `processRole` is
   classified by tool-call count at disconnect time. Nothing in this chain changes.

3. **Latency.** A re-encoding path would add a full parse-serialize round trip to every
   frame. The raw pipe adds only a memcpy in the kernel. For a latency-sensitive
   interactive tool like an MCP server, this matters.

4. **Simplicity.** The only parsing the proxy does is on the narrow intercept paths:
   JSON-RPC frames that are `tools/call` for `__proxy_restart_server` (inbound) and
   `tools/list` responses (outbound). Everything else is a byte copy. This minimizes
   the surface area for parsing bugs.

The trade-off is that the proxy cannot inspect or modify arbitrary frames — it is not a
general-purpose MCP proxy. This is intentional; see "What this is NOT" below.

## Cause classification on child exit

When the child closes, the proxy classifies the exit cause before deciding how to
respond:

| `code`       | `signal` | `ExitCause`  | Action                  |
| ------------ | -------- | ------------ | ----------------------- |
| `0`          | `null`   | `clean_exit` | Respawn immediately     |
| `null` / any | non-null | `signal`     | Respawn (proxy forward) |
| non-zero     | `null`   | `crash`      | Respawn + count failure |

**Signal-driven exits** occur when the proxy itself receives SIGTERM or SIGINT and
forwards it to the child. When `isShuttingDown = true`, the proxy does not respawn;
it exits after the child terminates.

**Crash exits** are counted in a sliding window (`FAILURE_WINDOW_MS = 60_000 ms`). If
`MAX_CONSECUTIVE_FAILURES = 5` crashes occur in the window, the proxy gives up and
exits with code 1. This prevents infinite restart loops for a fatally broken inner
server. The failure window resets automatically as old timestamps age out.

**Clean exits** from the staleness mechanism (mt#1322) always exit with code 0, so they
are classified as `clean_exit` and respawn immediately, bypassing the crash counter.
This means the staleness mechanism can trigger as many times as needed without
eventually causing the proxy to give up.

## Disconnect-tracker integration

The inner Minsky server's disconnect-tracker (mt#1645 / mt#1682 / mt#1705) is unaffected
by the proxy layer. The tracker discriminates:

- **`cause: "staleness_exit"`** — intentional exit from the staleness mechanism. Not
  escalation-eligible. The proxy's respawn absorbs the visible effect, but the tracker
  still records the event if the inner server fires its staleness-exit cause before
  calling `process.exit(0)`.

- **`processRole: "main_session"` vs. `"helper"`** — determined by tool-call count at
  disconnect time. The inner server increments its counter in `CallToolRequestSchema`
  handler on every tool call. Because the proxy forwards tool calls verbatim over the
  raw pipe, the inner server sees the same tool calls it would see without the proxy.
  `processRole` classification is unaffected.

- **`uptimeMs`** — measured from the inner server's own process start, not the proxy's.
  Each respawned child has a fresh uptime counter.

Net effect: from the disconnect-tracker's perspective, the proxy is invisible. Each
inner-server instance is a separate process with its own tracker state. Staleness
exits still appear as `cause: "staleness_exit"` and are not escalation-eligible.
Genuine long-lived-session closures (the user kills the proxy with SIGTERM) are tracked
correctly by the inner server's last instance.

## CLI opt-in

The proxy is an opt-in alternative to `minsky mcp start`. Switch by editing the
`minsky` server entry in `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "minsky": {
      "command": "minsky",
      "args": ["mcp", "proxy"], // was: ["mcp", "start"]
    },
  },
}
```

No other configuration is required. The proxy spawns `minsky mcp start` as its default
child command; the `--child-command` and `--child-args` flags on `minsky mcp proxy` are
available for non-default setups (e.g., pointing at a dev build or a different binary).

The CLI registration lives in `src/mcp/stdio-proxy/cli.ts` (`createProxyCommand()`).
It is mounted as `mcp proxy` in `src/commands/mcp/index.ts` alongside `mcp start`.

## What this is NOT

**Not a generic MCP proxy.** The proxy is Minsky-specific. It injects one Minsky-defined
meta-tool (`__proxy_restart_server`), interprets the `tools/list` response format, and
handles the Minsky-specific staleness-exit cause classification. A general-purpose MCP
reverse proxy would be a different artifact.

**Not an HTTP transport migration.** The proxy operates strictly on the stdio transport
that Claude Code uses. HTTP daemon mode (mt#1713) is a parallel effort that would
replace the stdio transport entirely, giving the server a persistent process regardless
of client connections. If mt#1713 ships, the proxy becomes unnecessary for users who
switch to the HTTP transport.

**Not in-place hot-module reload.** mt#1713 Shape 3 (deferred design alternative) would
reload Minsky's source modules in-process without restarting the server process at all.
The proxy is a coarser mechanism: full child-process respawn with a brief 200 ms gap
during which no tool calls can be served. Shape 3 would eliminate that gap but requires
significantly more implementation work.

**Not multi-tenant.** The proxy manages exactly one inner-server child at a time. It
does not multiplex multiple clients or route requests across multiple child instances.
Each `minsky mcp proxy` invocation manages one child process.

## Cross-references

- **mt#1322** — staleness-exit mechanism: inner Minsky server's `triggerStaleSignal()`
  function that causes the clean `process.exit(0)` the proxy absorbs.
- **mt#1645 / mt#1682 / mt#1705** — disconnect-tracker: measurement layer, cause
  classification, and process-role discrimination that remain unaffected by the proxy.
- **mt#1714** — implementation task for this proxy.
- **mt#1717** — sibling nudge hook: a complementary mechanism that nudges the agent to
  call `__proxy_restart_server` when it detects a staleness exit during a tool call.
- **mt#1713** — HTTP daemon RFC: the parallel effort that would make the proxy
  unnecessary for users willing to switch transport.
- **mt#1716** — Gate (i) for `/plan-task`: planning-time check that catches tasks
  attempting to edit Minsky source without the proxy or an HTTP-daemon in place.
- **`docs/mcp-signaling-spike-findings.md`** — mt#1315 spike: empirical survey of
  signaling surfaces and why none of them provided a clean solution without the
  supervisor-below approach.
- **`src/mcp/stdio-proxy/proxy.ts`** — `MinskyStdioProxy` class: core supervisor
  implementation, Transform stream wiring, respawn logic, signal handlers.
- **`src/mcp/stdio-proxy/tools.ts`** — `augmentToolsListResponse()`,
  `isProxyRestartRequest()`, `makeToolCallResponse()`, `PROXY_RESTART_TOOL_ENTRY`.
- **`src/mcp/stdio-proxy/cli.ts`** — `createProxyCommand()`: CLI subcommand registration.
- **`src/mcp/stdio-proxy/index.ts`** — public re-exports.
- **`tests/mcp/stdio-proxy/proxy.test.ts`** — supervisor lifecycle tests.
- **`tests/mcp/stdio-proxy/tools.test.ts`** — tool augmentation and intercept tests.
