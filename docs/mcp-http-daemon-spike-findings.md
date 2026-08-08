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

### mt#3811 cleanup (2026-08-08)

Port 48792, bound `127.0.0.1` only throughout. Every daemon and client process spawned across all
three experiments (including the two extra daemons from the Experiment 3 contamination —
one self-spawned by a client, one this experiment's own restart attempt that hit `EADDRINUSE`
and did not exit on its own) was individually confirmed dead by PID after the run, followed by a
broad final sweep:

```
$ ps aux | grep "claude -p" | grep -v grep | wc -l
0
$ ps -Ao pid,ppid,rss,command | grep "mcp start --http" | grep -v grep
(empty)
$ lsof -iTCP:48792 -sTCP:LISTEN
(empty)
```

The scratch `--mcp-config` and token lived under `/tmp/mt3811-spike/`, never inside the repo, and
were removed (`rm -rf`) once all data was extracted from the run.

One process-hygiene note surfaced by this run, distinct from mt#3764's original finding: the
daemon's own `[mt#3764] Parent process died (ppid changed ... -> 1); exiting orphaned HTTP MCP
server` watcher fired on some (not all) of this spike's `nohup ... & disown`-backgrounded daemon
starts, self-reaping the daemon within its ~5s poll interval before a client had connected. This
is the watcher working as designed against a genuinely-orphaned process — it just meant a few
daemon starts self-exited before I could use them, which cost debugging time but not a leaked
process. `MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT=1` (documented in `src/mcp/orphan-exit.ts`) was
used for the remaining spike runs to keep the daemon alive across the many separate shell
invocations this measurement required; this is not something a supervised deployment (tray
supervisor, or a real terminal session) would need, since there the daemon's actual parent process
does not exit.

## Overall verdict (mt#3811)

**Resource case: unchanged.** Daemon RSS at N=1/5/10 shows no growth signal above ~90 MB of
GC/allocator noise; even a deliberately pessimistic reading (the single highest sample observed
across all runs, ~257 MB) keeps the shim topology's total at the census's ~40 conversations at
`~38 MB × 40 (shim) + ~257 MB (daemon, pessimistic) ≈ 1.78 GB`, next to baseline's ~3.4 GB —
**≈ -48%**, materially the same as ADR-038's existing ≈ -50% estimate. The daemon's own footprint
turns out to be small relative to the shim's own per-process floor (~1.5 GB across 40
conversations) — it was never the daemon that was leaving the ≈ -95% of direct HTTP on the table;
it is the shim's own ~38 MB/conversation cost, which this task did not re-measure (already
measured in ADR-038 §Question 1) and does not change.

**Restart-recovery case (daemon already back up): confirmed safe.** N=6 concurrent clients all
recovered transparently in single-digit-to-low-double-digit milliseconds with zero surfaced
failures — directly validates ADR-038 §Question 6's "shared fate is measured and cheap" framing
for this specific case.

**Cold-start-window case: a real, previously-unmeasured exposure.** A tool call landing while
nothing is listening (the ~5.1s median cold-start gap mt#3766 measured) gets an immediate hard
failure surfaced into the model's turn — not the transparent, sub-15ms recovery of the
already-back-up case. Recovery then depends on agent-level retry behavior, which is not
guaranteed: in the observed run, the agent retried once and then gave up, surfacing the failure to
the user. ADR-038 §Question 6 characterizes this as "a tool call issued during the restart window
fails and retries, and the retry is the recovery path" — that undersells it; the retry is model
behavior, not a client mechanism, and this measurement shows model behavior can decline to keep
retrying.

**Net: proceed on resources, but the default flip should not ship without addressing the
cold-start window.** Nothing here undercuts the ≈ -50% shim-topology resource case, so ask#7273's
"does the ≈ -50% (not ≈ -95%) number change the calculus" question resolves to **no, it does not
change the calculus** — the daemon was never the reason the shim gives up half of direct HTTP's
win. But §Question 6's restart-safety framing needs revision: a daemon restart is transparent only
when a client's next call lands after the daemon is back up, and the ~5.1s cold-start window is a
real gap where at least one of N concurrent conversations issuing a call during a planned or
crash restart will see a hard, non-transparent failure. This should be scoped into Phase 2 (mt#3812's
shim, or the daemon supervisor mt#3814/mt#3815) as an explicit requirement — e.g., the shim
retrying with backoff around a connection-refused specifically — rather than assumed to come free
from "lazy per-client reinit," which this measurement shows is not sufficient on its own for calls
landing inside the cold-start window itself.

---

## N-scale measurement — mt#3811 (2026-08-08)

> **Status:** Fills the two figures mt#3766 (above) and ADR-038 explicitly declined to claim:
> daemon RSS at N concurrent sessions, and N-client restart recovery. Driven with real `claude -p`
> clients pointed **directly at the daemon over HTTP** — no shim in the path. See
> [Methodology note: no shim](#methodology-note-no-shim) for why that does not affect either
> measured quantity.

**Claude Code version tested:** 2.1.226. Daemon: `minsky mcp start --http --host 127.0.0.1`, same
static-bearer-token auth path as mt#3766.

### Methodology note: no shim

The mt#3811 spec's `## Scope` says to drive clients "through shims"; the shim (mt#3812) is not
built. Both quantities measured here are properties of the **daemon** and the **client**, not of
what sits between them:

- **Daemon RSS at N sessions** — the daemon allocates one `httpSessions` Map entry per connected
  client (`src/mcp/server.ts`); it cannot tell a client reached it through a shim from one that
  connected directly, so the RSS slope is identical either way.
- **N-client restart recovery** — the behavior under test is Claude Code's own HTTP client
  reissuing `InitializeRequest` after a restart invalidates its `Mcp-Session-Id`. A shim would
  only pipe the same frames through unchanged.

Clients were driven with `type: "http"` in a scratch `--mcp-config` (same shape as mt#3766's,
below), never committed to the repo.

```json
{
  "mcpServers": {
    "minsky-spike": {
      "type": "http",
      "url": "http://127.0.0.1:48792/mcp",
      "headers": { "Authorization": "Bearer <spike-token>" }
    }
  }
}
```

Each RSS-measurement client ran a fixed sequence via `claude -p`: call `debug_echo`, hold the
connection open with a **foreground** `perl -e 'select(undef,undef,undef,N)'` (a bare `sleep N`
Bash command is intercepted and backgrounded by the harness after a 5s grace period, which tears
down the tool-call span and defeats the "N clients held open concurrently" design — `perl`'s
`select`-based sleep is not pattern-matched and runs to completion in the foreground), then call
`debug_echo` again.

### Experiment 1: daemon RSS at N = 1, 5, 10 concurrent sessions

**Method:** for each N, spawn N clients simultaneously, wait ~40s for the initial
connection-burst's GC/allocator activity to decay (see below — this decay is itself slow), then
sample the daemon's RSS via `ps -o rss=` five times at ~7s intervals while all N clients remained
confirmed alive (`ps -p <pid>`) and connected. Two independent runs were made per N (a first pass
with a shorter 12s settle buffer, and a refined pass with a ~40s settle buffer); all raw samples
are reported.

| N   | Settled samples (KB), refined run      | Settled samples (KB), first run       | Combined median |
| --- | -------------------------------------- | ------------------------------------- | --------------- |
| 1   | 136080, 146032, 145312, 106608, 106736 | 118960, 128960, 101712, 98832, 96608  | ~110 MB         |
| 5   | 201504, 147968, 175408, 172816, 169488 | 88096, 116240, 199008, 256752, 211088 | ~170 MB         |
| 10  | 125264, 113840, 87808, 88400, 85632    | 121344, 106656, 123920, 106832, 88384 | ~104 MB         |

**Finding: no monotonic RSS growth with N is resolvable in the 1–10 range.** The median at N=10
(~104 MB) is _lower_ than the median at N=5 (~170 MB) and close to the median at N=1 (~110 MB).
This is not evidence that concurrent sessions are free — it is evidence that at this N range, `ps`
RSS on this Bun process is dominated by GC/allocator burst-and-decay tied to **recent connection
churn**, not by the number of concurrently-open sessions.

This was independently confirmed by sampling RSS with **zero** clients connected, immediately
after the N=5 run's clients had all disconnected:

```
N=0 (no clients, decaying after N=5 load): 169488, 137952, 112528, 85904 KB, sampled 8s apart
```

The exact same 86–170 MB band appears with **no sessions open at all** — purely the previous
burst's heap decaying. Bun/JSC does not aggressively return freed heap pages to the OS; a `ps`
RSS reading taken within roughly a minute of a connection burst (session establishment plus the
crypto/JSON work of handling auth headers and JSON-RPC framing) reflects that burst's high-water
mark more than it reflects live occupancy.

**Per-session slope: not measurable above noise in this range.** All 30 in-session RSS samples
(10 per N step, N=1/5/10) fall inside an 84–257 MB band that is reproduced by zero-client decay
alone. An upper bound can be reasoned from the code structure instead of the noise-dominated
`ps` numbers: each `httpSessions` entry (`src/mcp/server.ts:380`) holds references to an MCP SDK
`Server` + `Transport` pair — no subprocess, no dedicated per-client buffer pool — so the true
structural marginal cost per session is very likely well under the ~90 MB noise floor itself, but
this measurement cannot put a number on it more precise than "small relative to the observed
swings."

### Experiment 2: restart recovery with N ≥ 5 clients live

**Method:** 6 clients spawned concurrently, each holding a connection open via the foreground
`perl` wait (45s hold). Once all 6 were confirmed connected and mid-wait, the daemon process was
killed and a fresh daemon was started on the same port with the same bearer token — the daemon
was healthy again within ~1s (the "already-listening-by-next-call" case, not the cold-start-window
case; see Experiment 3 for that).

**Result: 6/6 clients recovered transparently. Zero clients surfaced a tool failure into their
model turn.** Recovery latency per client (time from the `-32001 Session not found` JSON-RPC
error to the retried call completing):

| Client | Recovery latency                                                                                |
| ------ | ----------------------------------------------------------------------------------------------- |
| 1      | 11ms                                                                                            |
| 2      | 9ms                                                                                             |
| 3      | 10ms                                                                                            |
| 4      | 8ms                                                                                             |
| 5      | 10ms                                                                                            |
| 6      | ~10ms (its first call landed after the restart; its second call found an already-valid session) |

All 6 clients' final output contained both expected raw JSON echoes with no error text — the same
`InitializeRequest`-reissue pattern mt#3766 documented for a single client (Experiment 1 there),
now confirmed at N=6 concurrent clients. This directly answers ADR-038 §Question 6's open
question ("whether N-client recovery holds") for the case where the daemon is already back up and
listening by the time each client's next call fires: **yes, recovery stays sub-15ms and fully
transparent at N=6.**

### Experiment 3: the cold-start window (a call landing while nothing is listening)

This is a different case from Experiment 2: instead of the daemon already being up again by the
time a client's next call fires, the client's call is timed to land while the daemon is **fully
down** — nothing listening on the port at all (as opposed to a live daemon that no longer
recognizes a stale session ID).

**Method:** one client established a session (first `debug_echo` call confirmed successful), then
the daemon was killed and deliberately **not** restarted before the client's second call fired.

**First attempt — result contaminated, but revealing.** The first run of this experiment used
a broad `--allowedTools "Bash,mcp__minsky-spike__debug_echo"` grant with no constraint on what the
Bash tool could be used for. On hitting "Unable to connect," the **client's own model** used its
Bash access to launch a _second, competing_ `minsky mcp start --http` daemon on the same port —
unprompted, and with different flags (`--require-auth`) than the one this experiment was
measuring. It won the port-bind race against a daemon this experiment separately tried to
restart, which then crashed with `EADDRINUSE` and (a separate, notable gap) **did not exit its
process despite an uncaught exception** — both processes were discovered and killed during
cleanup. This is a real leaked-process risk distinct from mt#3764's original finding: **an
agentic client with Bash access can self-remediate an MCP connection failure by spawning a
duplicate daemon process**, worth a note for anyone building a client-side supervisor that grants
broad shell access. The experiment was re-run with an explicit prompt instruction not to touch any
MCP server process, and that instruction was honored in the clean run below.

**Clean run — result.** With the daemon killed and left down, the client's second `debug_echo`
call failed immediately:

```
2026-08-08T06:23:03.314Z  Calling MCP tool: debug_echo
2026-08-08T06:23:03.315Z  Connection error: Unable to connect. Is the computer able to access the url?
2026-08-08T06:23:03.315Z  Tool 'debug_echo' failed after 0s: Unable to connect. Is the computer able to access the url?
```

Failure surfaced in ~1-4ms — no automatic transport-level retry or backoff loop was observed for
this failure class (unlike the stale-session-on-a-live-daemon case in Experiment 1/2, where
recovery happens inside the _same_ `tool_dispatch` span with no failure ever surfacing). The
**agent itself** decided to retry, ~2.9s later:

```
2026-08-08T06:23:06.187Z  Calling MCP tool: debug_echo
2026-08-08T06:23:06.188Z  Tool 'debug_echo' failed after 0s: Unable to connect. Is the computer able to access the url?
```

Also failed. The agent then **stopped retrying** (its own 2-strikes-style discipline) and reported
the failure verbatim to the user rather than continuing to retry:

> "The second `debug_echo` call did not return a result. Both attempts failed with, verbatim:
> `Unable to connect. Is the computer able to access the url?` ... Stopped there per the 2-strikes
> rule; no server process was started, restarted, killed, or otherwise touched."

The daemon was restored ~20s later, after the client process had already exited — the client
never got a chance to benefit from it.

**Verdict: hard failure, not retry-with-backoff.** A tool call landing in the genuine
"nothing listening" window gets an immediate hard failure surfaced into the model's turn. Recovery
is not automatic at the transport layer for this failure class — it depends entirely on
agent-level retry behavior, which is neither guaranteed nor bounded, and in the observed run gave
up after two attempts and surfaced the failure to the user. This is a materially different outcome
than the "daemon already back up" case in Experiment 2, and it means ADR-038 §Question 6's framing
— "a tool call issued during the restart window fails and retries, and the retry is the recovery
path" — undersells the exposure: the retry is not a client-side mechanism, it is model behavior,
and model behavior can (and here did) give up.

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
