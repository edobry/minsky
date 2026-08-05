# MCP HTTP Daemon Spike Findings — mt#3766

> **Status:** All three experiments run against the real Claude Code client (not a curl-only
> simulation). Experiment 1 (the load-bearing unknown) has a definitive PASS verdict with
> server- and client-side evidence, reproduced across 2 independent repetitions plus a
> naturally-occurring connection-refused variant. Experiment 2 has 3 timed runs + median.
> Experiment 3 has a definitive NOT-SUPPORTED verdict with the exact client-side error.

**Claude Code version tested:** 2.1.222 (binary at `/Users/edobry/.local/bin/claude`)

---

## Methodology

All three experiments drove a real `claude -p --mcp-config <scratch-config> --strict-mcp-config`
process against a locally-spawned `minsky mcp start --http` daemon (bound to `127.0.0.1` only).
`--debug-file` was used to capture the client's internal MCP-transport debug log alongside the
model's final text output, so every finding below has both the client's decision-log evidence
and, where relevant, the server's response.

**Auth side-finding (relevant context for all three experiments).** `minsky mcp start --http`
auto-wires an OAuth-protected-resource layer (`oidc-provider`) whenever a Postgres-backed
persistence provider is available — independent of the `--require-auth` flag, which only adds a
_second_, simpler mechanism (a static bearer token from `MINSKY_MCP_AUTH_TOKEN`). Against the
`minsky` project itself (Postgres/Supabase-backed), a bare `initialize` POST returns `401` with
`WWW-Authenticate: Bearer resource_metadata="...(RFC 9728)..."` even with no flags passed
(`src/commands/mcp/start-command.ts`, `authRequired = auth.enabled || !!oauthProvider`). The
static-bearer path is explicitly preserved in the code as "the local Claude Code daemon path"
(short-circuits before OAuth validation), so this spike used it: set
`MINSKY_MCP_AUTH_TOKEN=<spike-generated-token>` on the daemon and passed the same token via
`headers: { Authorization: "Bearer <token>" }` in the scratch MCP config. This is a real
constraint Phase 2 (mt#1713) needs to account for — a shared daemon against a Postgres-backed
project is not reachable by an unauthenticated client by default.

Scratch MCP config shape used for experiments 1 and 2:

```json
{
  "mcpServers": {
    "minsky-spike": {
      "type": "http",
      "url": "http://127.0.0.1:48765/mcp",
      "headers": { "Authorization": "Bearer <spike-token>" }
    }
  }
}
```

Config and logs lived under a scratch tmp directory for the whole spike, never committed.

---

## Experiment 1: session-ID invalidation on daemon restart

> **Question:** When a request carries a stale `Mcp-Session-Id` (server restarted mid-session),
> does Claude Code's client transparently reissue an `InitializeRequest` and retry, per the MCP
> Streamable-HTTP spec's mandated 404→reinit contract — or does it surface a hard failure to the
> agent/user?

### Setup

- Daemon started with `MINSKY_MCP_AUTH_TOKEN` set, `--host 127.0.0.1 --port 48765`.
- `claude -p` prompt: call `debug_echo` (message `call1`) → run `sleep 20` via the `Bash` tool →
  call `debug_echo` again (message `call2`) → report both raw results verbatim.
- `--allowedTools "Bash,mcp__minsky-spike__debug_echo"` (no interactive permission prompts).
- While the client was inside its `sleep 20` Bash call, the daemon was killed and a **fresh**
  daemon process was started on the **same port**, with the **same** bearer token. The fresh
  daemon's `/health` was polled and confirmed `200` **before** the client's sleep window ended
  and before the client's second tool call fired — isolating the "stale session ID rejected by a
  live server" path from a connection-refused path (that path is the cheap variant, below).
- 2 repetitions.

### Evidence — repetition 1

Timeline (all times same clock):

| Time (UTC)        | Event                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19:56:59.017      | Client starts `sleep 20` (Bash tool dispatch)                                                                                                                                                                                                                                                         |
| 19:57:11.5        | Old daemon killed (`kill <pid>`); `/health` immediately confirms `000` (down)                                                                                                                                                                                                                         |
| 19:57:11.8        | Fresh daemon spawned on the same port, same token                                                                                                                                                                                                                                                     |
| 19:57:12.505      | Old client's still-open SSE GET stream logs `Connection error: Unable to connect` (expected — daemon is down)                                                                                                                                                                                         |
| ≤19:57:19.1       | Fresh daemon `/health` confirmed `200` (well before the sleep ends)                                                                                                                                                                                                                                   |
| 19:57:19.112      | Client's `sleep 20` Bash call returns (`durationMs=20095`)                                                                                                                                                                                                                                            |
| 19:57:20.685      | Client issues `debug_echo` call 2 (`toolu_01DXmK8gCHjA9no3xKVwq9vm`)                                                                                                                                                                                                                                  |
| 19:57:20.690      | **Server responds** `{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}` — this is the Streamable-HTTP equivalent of the spec's 404-stale-session signal (JSON-RPC error code rather than a bare HTTP 404 body, since the POST already reached the new server process) |
| 19:57:20.690      | Client debug log: `"MCP session expired (server no longer recognizes session ID), triggering reconnection"` → `"Closing transport (session expired)"` → `"Cleared connection cache for reconnection"`                                                                                                 |
| 19:57:20.691      | `"Tool 'debug_echo' failed after 0s: MCP error -32000: Connection closed"` → `"MCP session expired during tool call (connection closed), clearing connection cache for re-initialization"` → `"Retrying tool 'debug_echo' after session recovery"`                                                    |
| 19:57:20.692–.707 | Client reissues **`InitializeRequest`** against the same URL: `"Initializing HTTP transport..."` → `"Successfully connected (transport: http) in 14ms"` → `"Connection established with capabilities: ..."`                                                                                           |
| 19:57:20.707–.723 | Client retries `debug_echo`: `"Calling MCP tool: debug_echo"` → `"Tool 'debug_echo' completed successfully in 16ms"`                                                                                                                                                                                  |
| 19:57:20.723      | `tool_dispatch_end ... outcome=ok durationMs=38`                                                                                                                                                                                                                                                      |

**Total time from stale-session error to successful retry: 38ms.** The whole recovery happened
inside a single `tool_dispatch_start`/`tool_dispatch_end` span — the agent's model turn never saw
a tool failure. The model's own final report even says "the second call succeeded with no
reconnect" — it is unaware the reconnect happened, which is itself informative: the recovery is
fully transparent to the agent, not just to the end user.

Raw client-log excerpt (verbatim, `exp1-run2-debug.log`):

```
2026-08-05T19:57:20.685Z [DEBUG] MCP server "minsky-spike": Calling MCP tool: debug_echo
2026-08-05T19:57:20.690Z [DEBUG] MCP server "minsky-spike": HTTP connection dropped after 33s uptime
2026-08-05T19:57:20.690Z [DEBUG] MCP server "minsky-spike": Connection error: Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}
2026-08-05T19:57:20.690Z [DEBUG] MCP server "minsky-spike": MCP session expired (server no longer recognizes session ID), triggering reconnection
2026-08-05T19:57:20.690Z [DEBUG] MCP server "minsky-spike": Closing transport (session expired)
2026-08-05T19:57:20.691Z [DEBUG] MCP server "minsky-spike": Cleared connection cache for reconnection
2026-08-05T19:57:20.691Z [DEBUG] MCP server "minsky-spike": Tool 'debug_echo' failed after 0s: MCP error -32000: Connection closed
2026-08-05T19:57:20.691Z [DEBUG] MCP server "minsky-spike": MCP session expired during tool call (connection closed), clearing connection cache for re-initialization
2026-08-05T19:57:20.692Z [DEBUG] MCP server "minsky-spike": Retrying tool 'debug_echo' after session recovery
2026-08-05T19:57:20.692Z [DEBUG] MCP server "minsky-spike": Initializing HTTP transport to http://127.0.0.1:48765/mcp
2026-08-05T19:57:20.707Z [DEBUG] MCP server "minsky-spike": Successfully connected (transport: http) in 14ms
2026-08-05T19:57:20.707Z [DEBUG] MCP server "minsky-spike": Connection established with capabilities: {"hasTools":true,...}
2026-08-05T19:57:20.707Z [DEBUG] MCP server "minsky-spike": Calling MCP tool: debug_echo
2026-08-05T19:57:20.723Z [DEBUG] MCP server "minsky-spike": Tool 'debug_echo' completed successfully in 16ms
2026-08-05T19:57:20.723Z [INFO] [Stall] tool_dispatch_end tool=mcp__minsky-spike__debug_echo ... outcome=ok durationMs=38
```

Client final text output (verbatim):

```
RESULT2:
{
  "success": true,
  "timestamp": "2026-08-05T19:57:20.710Z",
  "echo": { "message": "r2call2" },
  "interface": "mcp"
}
```

### Evidence — repetition 2

Identical pattern, independently reproduced with a second kill/restart cycle (new daemon pid,
same port, same token):

```
2026-08-05T19:58:41.174Z [DEBUG] MCP server "minsky-spike": Calling MCP tool: debug_echo
2026-08-05T19:58:41.184Z [DEBUG] MCP server "minsky-spike": Connection error: Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}
2026-08-05T19:58:41.184Z [DEBUG] MCP server "minsky-spike": MCP session expired (server no longer recognizes session ID), triggering reconnection
2026-08-05T19:58:41.185Z [DEBUG] MCP server "minsky-spike": Tool 'debug_echo' failed after 0s: MCP error -32000: Connection closed
2026-08-05T19:58:41.186Z [DEBUG] MCP server "minsky-spike": Retrying tool 'debug_echo' after session recovery
2026-08-05T19:58:41.186Z [DEBUG] MCP server "minsky-spike": Initializing HTTP transport to http://127.0.0.1:48765/mcp
2026-08-05T19:58:41.202Z [DEBUG] MCP server "minsky-spike": Successfully connected (transport: http) in 16ms
2026-08-05T19:58:41.203Z [DEBUG] MCP server "minsky-spike": Calling MCP tool: debug_echo
2026-08-05T19:58:41.221Z [DEBUG] MCP server "minsky-spike": Tool 'debug_echo' completed successfully in 18ms
2026-08-05T19:58:41.221Z [INFO] [Stall] tool_dispatch_end ... outcome=ok durationMs=47
```

Recovery time: 47ms. Reproduced.

_(An earlier, un-timed run without the restart — daemon left running throughout — confirmed the
baseline steady-state case: two `debug_echo` calls 27s apart against the same live daemon both
succeed with no reconnect logic invoked at all, as expected.)_

### Cheap variant: connection-refused (daemon down for part of the call window)

Captured as a natural side effect of the restart procedure above, not a separate run: while the
old daemon was down (killed, fresh one not yet listening), the client's **already-open SSE GET
stream** (a separate long-lived channel from the POST request/response cycle) attempted its own
backoff reconnect and gave up after 2 attempts in ~1.5s:

```
2026-08-05T19:58:30.361Z [DEBUG] MCP server "minsky-spike": Connection error: Unable to connect. Is the computer able to access the url?
2026-08-05T19:58:30.362Z [DEBUG] MCP server "minsky-spike": Connection error: Failed to reconnect SSE stream: Unable to connect. Is the computer able to access the url?
2026-08-05T19:58:31.865Z [DEBUG] MCP server "minsky-spike": Connection error: Maximum reconnection attempts (2) exceeded.
2026-08-05T19:58:31.865Z [DEBUG] MCP server "minsky-spike": SSE GET-stream reconnection exhausted; leaving transport up (POST still works)
```

This is a **separate, weaker retry loop** than the one that matters: the SSE stream's own
backoff gives up quickly and permanently ("leaving transport up (POST still works)" — the client
explicitly does not treat this as fatal). The actual recovery path that answers the spike's
question is the POST-triggered session-expiry retry documented above, which fires fresh on the
_next tool call_ regardless of the SSE stream's state, and is not subject to the 2-attempt cap.
So a daemon outage that exceeds the SSE backoff window does not block eventual recovery, as long
as the daemon is back up by the time the next tool call's POST goes out.

### Verdict: **PASS**

The Claude Code HTTP MCP client transparently reissues a fresh `InitializeRequest` and retries
the in-flight tool call when it receives a stale/unrecognized-session error, exactly as the MCP
Streamable-HTTP spec mandates. Recovery is sub-50ms and invisible to the agent's model turn —
no error surfaces, no retry logic is needed on the Minsky side, and the shared-daemon restart
path this de-risks for mt#1713 is **not** dead-on-arrival on the client-behavior axis. Reproduced
twice independently; the connection-refused sub-case (SSE-only) does not block it.

---

## Experiment 2: cold-start timing

> **Question:** How long from daemon spawn to the first successful `GET /health` `200`? Target:
> comfortably inside the ~31s client reconnect budget, ideally <5s.

3 runs, same command each time (`minsky mcp start --http --port 48770 --host 127.0.0.1 --repo
/Users/edobry/Projects/minsky`), daemon killed and port confirmed free between runs:

| Run | Elapsed (spawn → first `200`) |
| --- | ----------------------------- |
| 1   | 6.415s                        |
| 2   | 5.095s                        |
| 3   | 4.799s                        |

**Median: 5.095s.**

Raw output:

```
run 1: elapsed=6.415034000s (200 OK)
run 2: elapsed=5.094787000s (200 OK)
run 3: elapsed=4.798962000s (200 OK)
```

### Verdict

Median cold-start (5.1s) sits just above the spec's stretch target of "<5s" but with wide margin
(~6x) inside the ~31s client reconnect budget that actually gates the restart-transparency
question Experiment 1 answers. Run-to-run variance (4.8–6.4s) is consistent with normal process
and dependency-init jitter (the `oidc-provider` OAuth-provider setup and DB connection are part
of startup) rather than a systemic slowdown. Not a blocker for the Phase 2 design.

---

## Experiment 3: unix-socket support

> **Question:** Does Claude Code's HTTP MCP transport accept a `unix://` URL in an MCP config?

### Setup

Scratch config:

```json
{
  "mcpServers": {
    "minsky-spike-unix": {
      "type": "http",
      "url": "unix:///private/tmp/.../test.sock"
    }
  }
}
```

(No listener was needed at that path — the client rejects the URL before attempting to connect.)

### Evidence

```
2026-08-05T19:26:35.908Z [DEBUG] MCP server "minsky-spike-unix": Initializing HTTP transport to unix:///private/tmp/.../test.sock
2026-08-05T19:26:35.909Z [DEBUG] MCP server "minsky-spike-unix": Testing basic HTTP connectivity to unix:///private/tmp/.../test.sock
2026-08-05T19:26:35.909Z [DEBUG] MCP server "minsky-spike-unix": Parsed URL: host=, port=default, protocol=unix:
2026-08-05T19:26:35.911Z [DEBUG] MCP server "minsky-spike-unix": HTTP Connection failed after 4ms: protocol must be http:, https: or s3: (code: ERR_INVALID_ARG_VALUE, errno: none)
2026-08-05T19:26:35.911Z [ERROR] MCP server "minsky-spike-unix" TypeError [ERR_INVALID_ARG_VALUE]: protocol must be http:, https: or s3:
2026-08-05T19:26:35.911Z [ERROR] MCP server "minsky-spike-unix" Connection failed (ERR_INVALID_ARG_VALUE): protocol must be http:, https: or s3:
```

The client parses the URL, recognizes `protocol=unix:`, and rejects it 4ms later with a
`TypeError [ERR_INVALID_ARG_VALUE]` from its underlying HTTP client (`protocol must be http:,
https: or s3:`) — the session ends up with the MCP server marked failed; no further attempt is
made and no fallback transport is tried.

(A first attempt at driving this experiment without `--debug-file` hung until timeout — that was
an artifact of the two-step debug harness, not the client's actual unix-socket handling; the
`--debug-file` run above completed normally in well under a second and is the authoritative
result.)

### Verdict: **NOT SUPPORTED**

`unix://` URLs are explicitly rejected at the transport layer with a fast, clear, permanent
failure (`ERR_INVALID_ARG_VALUE`). The client's HTTP transport is limited to `http:`, `https:`,
and `s3:` schemes. Any Phase 2 design that wants a unix-domain-socket transport for the shared
daemon would need Claude Code to add support for it — no client-side workaround exists today.

---

## Cleanup

All daemon processes spawned by this spike (ports 48765 and 48770) were killed and confirmed
down — both via `/health` `000`/connection-refused checks during the runs, and a final
`ps aux | grep 'mcp start --http'` sweep after the spike, which showed zero processes bound to
either spike port. See the mt#3766 spec's `## Findings` section for the exact final `ps` output.
No daemon from this spike was left running.

---

## Summary answer (spec Acceptance Test 1)

**Does the shared-daemon restart path work against Claude Code's actual client?** Yes — on
Claude Code 2.1.222, the client transparently detects the stale-session error (JSON-RPC
`-32001 Session not found`) and reissues `InitializeRequest`, recovering within tens of
milliseconds with no visible failure to the agent. This was verified against the real `claude`
binary (not simulated), reproduced across 2 independent kill/restart cycles, with both
client-side debug-log evidence and server-side response evidence. Cold-start time (~5.1s
median) leaves a wide margin inside the client's reconnect budget. `unix://` transport is not
supported by the client and would need upstream Claude Code support to use.
