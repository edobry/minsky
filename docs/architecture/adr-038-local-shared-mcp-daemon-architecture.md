# ADR-038: Local shared MCP daemon — keep a thin per-conversation shim, because the HTTP transport carries no conversation identity

## Status

**Proposed** — 2026-08-06. Decided under mt#3808, the Phase-2 design step of mt#1713. The build
decision itself is already made (ask#7151, 2026-08-06 — operator chose the full build); this
record decides the architecture, not whether to build.

## The call

**Put the shared daemon behind a thin per-conversation stdio→HTTP shim rather than pointing
Claude Code at the daemon directly — because a direct HTTP connection carries no per-conversation
identifier by any route, and the shim recovers it for the price of a ~38MB byte-pipe.**

- Measured, not assumed: a real Claude Code 2.1.222 client sends **nothing** conversation-scoped
  over HTTP — not in headers, not in `initialize` params, not in `tools/call` `_meta`. The
  `${CLAUDE_CODE_SESSION_ID}` config-header trick resolves the _ambient_ environment, not the
  conversation, and silently emits a literal `${...}` when unset. §Question 1 has the capture.
- The shim preserves ADR-006 Layer-3 identity **unchanged and verified end-to-end** — the
  daemon received `_meta["io.minsky/agent_id"]` carrying the conversation's own id.
- The resource win halves rather than vanishes: ~38MB/conversation instead of today's measured
  ~119MB proxy+server pair. Against the ~3.4GB / ~40-pair census baseline that is roughly
  **-50%**, not the ~-95% direct-HTTP would deliver. Stated plainly because it weakens the case.
- Two daemons, not one: the MCP daemon and the cockpit daemon stay separate processes under one
  generalized tray supervisor. mt#2427 is **extended**, not superseded.
- Migration gets cheaper as a side effect: the Claude Code config change is a `command`/`args`
  swap inside the existing `type: "stdio"` block, not a transport-type change.

Accepting this ADR means agreeing that conversation-grain identity is worth ~38MB per
conversation, and that halving the process cost is a sufficient win to build for.

## Context

Today every Claude Code conversation runs its own `minsky mcp proxy` supervising its own
`minsky mcp start` child (mt#1714, `docs/architecture/stdio-proxy.md`). mt#1713 proposes replacing
that with one shared local HTTP daemon. The Phase-1 spike (mt#3766,
`docs/mcp-http-daemon-spike-findings.md`) retired the protocol risk: Claude Code 2.1.222
transparently reissues `InitializeRequest` on a stale session and retries the in-flight call in
38–47ms; cold start is ~5.1s median; `unix://` URLs are rejected outright.

What the spike did **not** touch is the question that decides the topology. ADR-006 Layer-3
conversation-scoped identity is injected today by the stdio proxy, which reads
`CLAUDE_CODE_SESSION_ID` out of the per-process environment Claude Code sets on each spawned MCP
server and stamps `_meta["io.minsky/agent_id"]` onto every `tools/call`
(`src/mcp/stdio-proxy/conversation-identity.ts`, `injectAgentIdMeta` at L101). A daemon reached
over TCP has no per-conversation environment. Whether Claude Code's HTTP transport conveys a
conversation identifier by some other route was an open empirical question, and everything
downstream depends on the answer.

---

## Question 1 — Topology and conversation identity

### What was actually observed

A minimal Streamable-HTTP MCP endpoint was stood up on `127.0.0.1:48799` that logged **every**
inbound HTTP header and **every** JSON-RPC body to a JSONL capture file, and a real `claude`
binary was pointed at it:

```
claude -p --mcp-config <scratch-config> --strict-mcp-config \
       --allowedTools "mcp__probe__probe_echo"     # prompt on stdin
```

Claude Code version **2.1.222**. Bound to `127.0.0.1` only; config and capture lived in a
scratch directory outside the repo; the probe process was killed and its absence verified by
`ps` and `lsof -iTCP:48799 -sTCP:LISTEN` afterwards. 19 records captured across the direct-HTTP
runs.

**Observation A — the complete inbound header set.** Union of every header name seen across
every request:

```
accept  accept-encoding  connection  content-length  content-type
host  mcp-protocol-version  mcp-session-id  user-agent
```

Verbatim headers on an `initialize` POST (identical across all four initializes captured):

```
accept:           application/json, text/event-stream
accept-encoding:  identity
connection:       keep-alive
content-length:   323
content-type:     application/json
host:             127.0.0.1:48799
user-agent:       claude-code/2.1.222 (sdk-cli)
```

No conversation-bearing header exists. `mcp-session-id` is absent on `initialize` (the **server**
mints it) and thereafter echoes back whatever the server issued — it is a server-owned handle,
not client-supplied identity.

**Observation B — `initialize` params are byte-identical across different conversations.**
Captured from two separate `claude` invocations:

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "roots": { "listChanged": true }, "elicitation": {} },
  "clientInfo": {
    "name": "claude-code",
    "title": "Claude Code",
    "version": "2.1.222",
    "description": "Anthropic's agentic coding tool",
    "websiteUrl": "https://claude.com/claude-code"
  }
}
```

Nothing distinguishes one conversation from another. No conversation id, no cwd, no session
handle.

**Observation C — `tools/call` `_meta` carries a per-CALL id, not a per-conversation one.**
The two conversations' tool calls arrived as:

```json
"_meta":{"claudecode/toolUseId":"toolu_01JXeBn1e7jRwa9GbDMW5nwL","progressToken":2}   // conversation 1
"_meta":{"claudecode/toolUseId":"toolu_01FLjHPkcvQxLnHEdLyWb2AE","progressToken":2}   // conversation 2
```

`claudecode/toolUseId` is minted per tool call. It cannot group calls belonging to one
conversation, which is exactly what ADR-006 Layer 3 needs.

**Observation D — `Mcp-Session-Id` is not 1:1 with a conversation.** Four distinct transport
sessions were minted across two conversations. The captured sequence:

```
02:53:56.927  POST initialize -> probe-session-1   (then initialized, GET, tools/list)
02:53:59.014  POST initialize -> probe-session-2   (then initialized, GET, tools/list)
02:54:15.472  POST initialize -> probe-session-3   ... 02:54:26.183 tools/call  message="runA"
02:54:29.369  POST initialize -> probe-session-4   ... 02:54:36.564 tools/call  message="runB"
```

A single conversation minted more than one transport session. So even the _degraded_ fallback —
keying identity on `Mcp-Session-Id` — over-counts conversations, and it is additionally reset by
every daemon restart (mt#3766).

**Observation E — the config-header env-expansion route resolves ambient environment, not the
conversation.** Claude Code does expand `${VAR}` inside an HTTP MCP entry's `headers`, which
looks at first like a way to inject identity. It is not. Three runs against
`"X-Minsky-Agent-Id": "${CLAUDE_CODE_SESSION_ID}"` (with a control header
`"X-Minsky-Literal": "sentinel-literal"` present throughout):

| Launching environment                                                | Header value that arrived                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CLAUDE_CODE_SESSION_ID` inherited from the dispatching conversation | `ee5de4a2-3e26-4fd1-a1da-1bb0472d48f5` — the **dispatcher's** id, not the running conversation's |
| `CLAUDE_CODE_SESSION_ID=SENTINEL-FROM-PARENT`                        | `SENTINEL-FROM-PARENT`                                                                           |
| `env -u CLAUDE_CODE_SESSION_ID`                                      | the literal string `${CLAUDE_CODE_SESSION_ID}`                                                   |

Expansion is a static string interpolation against the process environment at config-load time.
The client never substitutes its own conversation id. And when the variable is unset it does not
error and does not send empty — it sends the literal `${...}`, a silent failure mode that any
design depending on this mechanism would inherit.

**Observation F — the shim route works, verified end-to-end.** The same probe endpoint was
reached through a minimal Bun stdio→HTTP bridge configured as an ordinary `type: "stdio"` entry.
The `tools/call` that arrived at the daemon carried:

```json
"_meta":{"claudecode/toolUseId":"toolu_01BvcjuQ6fb5h1fRrZuQaD2f","progressToken":2,
         "io.minsky/agent_id":"a62a7d9e-5006-49f2-9c2b-868d5282b103"}
```

(`user-agent: Bun/1.3.14` — the shim, not the client.) The stamped id
`a62a7d9e-…` is the spawned conversation's **own** id, distinct from the dispatching
conversation's `ee5de4a2-…`. That contrast is the proof: Claude Code sets
`CLAUDE_CODE_SESSION_ID` on a spawned stdio child to _that child's_ conversation id, while the
HTTP header expansion in Observation E resolved the _ambient_ one. Same experiment pair, opposite
results, one mechanism explains both.

### Verdict on identity

**Claude Code's HTTP MCP transport conveys no per-conversation identifier — verified by direct
capture of every header and every JSON-RPC body from a real 2.1.222 client, across headers,
`initialize` params, `tools/call` `_meta`, and the config-header env-expansion route.** The claim
is bounded to what was checked: Claude Code 2.1.222 on the `sdk-cli` (`claude -p`) code path.
The interactive TUI was not captured; the transport implementation is shared, but treat the
interactive path as `inferred` rather than `verified` until someone captures it.

### The measured cost of the shim

Live census, 2026-08-06, `ps -Ao pid,ppid,rss,command` filtered to the two process classes:

| Class                                   | Count | Total RSS | Mean RSS |
| --------------------------------------- | ----- | --------- | -------- |
| `minsky mcp start` (inner server)       | 50    | 3172.9 MB | 63.5 MB  |
| `minsky mcp proxy` (today's supervisor) | 46    | 2553.2 MB | 55.5 MB  |

96 processes, ~5.73 GB — a mean of **~119 MB per conversation pair**. Note that today's proxy is
itself ~55MB: it runs the full Minsky bundle, so it is not a byte-pipe.

A genuinely thin shim — no Minsky imports, no command registry, no DB; stdin line reader,
`_meta` stamp, `fetch`, stdout writer — was measured live while a `claude` client drove two tool
calls through it. Three `ps` samples at 3s intervals:

```
36.0 MB   36.0 MB   38.6 MB
```

That is essentially the Bun runtime floor.

### Revised resource win, against the census baseline

The mt#1713 baseline is **~40 pairs, ~3.4 GB**.

| Topology                      | Per-conversation cost | ~40 conversations    | vs baseline |
| ----------------------------- | --------------------- | -------------------- | ----------- |
| Today (proxy + inner server)  | ~119 MB               | ~3.4 GB (baseline)   | —           |
| **Thin shim + shared daemon** | ~38 MB                | ~1.5 GB + one daemon | **≈ -50%**  |
| Direct HTTP + shared daemon   | 0                     | one daemon           | ≈ -95%      |

The daemon's own RSS at N=40 concurrent sessions is **unmeasured** — a single-session
`minsky mcp start` is 63.5 MB, and per-session overhead at scale has not been observed. Do not
quote a total until mt#3811 measures it.

Stated plainly: **choosing the shim gives up roughly half of the available win.** It is still a
real win — the shim costs ~32% of today's pair, and ~60% of today's inner server alone — and it
buys back the whole identity layer. But the ADR should not pretend the two options are close on
resources.

### Decision

**Adopt the thin per-conversation stdio→HTTP shim.** Claude Code spawns the shim over stdio
exactly as it spawns the proxy today; the shim stamps `_meta["io.minsky/agent_id"]` from
`CLAUDE_CODE_SESSION_ID` and forwards to one shared HTTP daemon on localhost.

Why this over direct HTTP, given direct HTTP is twice as good on the only metric this project is
being built for: the alternative is not "slightly worse attribution." ADR-006 Layer 3 would be
**unreachable** — there is no route to it, as opposed to a route that is merely awkward — and
every subsystem keyed on conversation-grain identity would silently fall back to the Layer-1
ascribed `unknown:hash:<…>` form: presence claims (`tasks_claims_list`), dispatch attribution,
the PR-author and session-creator workspace↔conversation links (mt#3101/mt#3120), attention
accounting, and transcript↔workspace correlation. Worse, per Observation D the fallback key
(`Mcp-Session-Id`) is not even a stable over-approximation — it churns within a conversation and
resets on every daemon restart, so the degradation is not "coarser identity," it is _unstable_
identity, which is worse than none for anything that aggregates.

The shim also strictly improves on today's per-conversation process: ~38 MB replaces a ~55 MB
proxy, and the shim has no bundle to rebuild, so the ~10–30s post-merge rebuild latency the
proxy currently absorbs moves to the (single, supervised) daemon.

---

## Question 2 — Cockpit-daemon relationship

**Decision: two separate daemons, one supervisor.** The MCP daemon does not merge into the
cockpit daemon.

- **Different failure domains.** The mt#1322 staleness-exit fires on a Minsky source change and
  is transport-agnostic — a unified process would blank the cockpit UI every time an MCP-relevant
  merge landed, and would drop all N conversations' tool surface every time a cockpit-only change
  shipped. Today those are independent; unification couples them.
- **Different auth postures.** The cockpit is a browser surface on `:3737`; the MCP daemon
  auto-wires an OAuth protected-resource layer whenever Postgres persistence is configured
  (Question 5). Merging forces one HTTP server to carry both models.
- **The saving is one process's baseline.** ~64 MB, once — against coupling two independent
  lifecycles. Not worth it.
- ADR-014's single-owner-of-port invariant is **per port**; two daemons on two ports compose with
  it without amendment.

This discharges mt#2141's surviving question (unify-or-separate). mt#2141's evaluation deliverable
is otherwise fully discharged by mt#1713's decision package plus mt#3766's findings; it is closed
as superseded with a pointer here.

---

## Question 3 — Supervision

**Decision: generalize the ADR-014 tray supervisor from one hardcoded daemon to a registry of N
named daemons, and register the MCP daemon as the second entry.**

Each registry entry carries: name, command + args, port, health path, expected health-body
service identity, and adopt-vs-spawn policy. The MCP daemon's entry names
`minsky mcp start --http --host 127.0.0.1 --port <port>` and asserts
`service: "minsky-mcp"` on `/health` — a status code alone is not proof the right service
started (mt#3148, `packages/domain/src/deployment/health-identity.ts`).

Everything ADR-014 already decided carries over per-entry unchanged: spawn-as-managed-child,
adopt-an-existing-listener rather than double-spawn, respawn-with-throttle, stdio→log
redirection, teardown on Quit, single-owner-of-port.

**Composition with mt#3764 (merged 2026-08-05).** HTTP-mode `mcp start` now self-terminates on a
ppid transition to 1 and when never connected. A tray-spawned daemon is a managed child, so its
ppid is the tray; if the tray dies the daemon is reparented to pid 1 and self-exits rather than
becoming the 4GB orphan that motivated mt#3764. This is the correct behavior for a supervised
local daemon and requires no change to either mechanism — but the supervisor must not
double-count that self-exit as a crash for throttling purposes.

**Relationship to mt#2427: EXTENDED, not superseded.** mt#2427 delivers a configurable port for
the cockpit daemon and explicitly scopes multi-daemon/multi-port simultaneous supervision OUT.
This ADR lifts that boundary and folds mt#2427's deliverable in as one field of the per-daemon
record. mt#2427's requirement remains valid and its work is not discarded; its scope line is
superseded by this record. If mt#2427 is still unstarted when Question 3's subtask begins, that
subtask absorbs it.

---

## Question 4 — Port allocation

**Decision: a fixed default port (`48765`) is the contract; conflict detection is
identity-asserting adopt-or-fail; a discovery file exists for tooling, never for the client.**

The Claude Code config is static and its reconnect logic targets the configured URL, so the URL
cannot be dynamic — a discovery file cannot serve the client, only the supervisor and CLI. It is
written by the daemon at `~/.local/state/minsky/local-mcp.json` (port, pid, started-at) so
`minsky` commands and the tray can find a daemon they did not spawn.

On bind failure the supervisor probes `/health` on the occupied port:

- Health body asserts `service: "minsky-mcp"` → **adopt** (ADR-014's adopt path).
- Anything else, or no response → **fail loudly** with the occupying pid, never silently pick a
  different port. A different port is a URL the configured clients will not reach, so a silent
  fallback produces a running daemon nobody talks to.

Unix domain sockets are ruled out: the client rejects `unix://` with
`ERR_INVALID_ARG_VALUE: protocol must be http:, https: or s3:` (mt#3766, Experiment 3).

---

## Question 5 — Auth

**Decision: a static bearer token, generated at setup, stored `0600`, and written LITERALLY into
the Claude Code MCP config — not referenced as an environment variable.**

Grounding, from the spike: `minsky mcp start --http` auto-wires an OAuth protected-resource layer
whenever a Postgres-backed persistence provider is available, independent of `--require-auth`
(`src/commands/mcp/start-command.ts`: `authRequired = auth.enabled || !!oauthProvider`). Against
this project a bare `initialize` returns `401` with an RFC-9728 `WWW-Authenticate` header even
with no flags. So "localhost, no auth" is not an available option — the daemon is auth-required by
default. The static-bearer path short-circuits before OAuth validation and is preserved in the
code specifically as the local Claude Code daemon path; that is the path this design uses.

The token is generated by `minsky setup local-http`, written to
`~/.config/minsky/local-mcp-token` (`0600`), passed to the daemon via `MINSKY_MCP_AUTH_TOKEN`,
and — because the shim topology means the client talks stdio, not HTTP — read by the **shim**,
which attaches it upstream. The client config never carries the token at all.

**Why "literally, not `${VAR}`" is called out even though the shim makes it moot for the primary
path:** Observation E measured that `${VAR}` in an HTTP MCP entry expands against ambient
environment and, when the variable is unset, sends the literal `${CLAUDE_CODE_SESSION_ID}` string
with no error. Any future direct-HTTP escape hatch that templated a token that way would fail as
a confusing `401` rather than a clear misconfiguration. Record the constraint so it is not
rediscovered.

---

## Question 6 — Shared fate and blast radius

**Decision: accept shared fate for the restart path, which is measured and cheap; treat the
poison-request path as the real new risk and cap it with the existing idle reaper plus a
measurement subtask before the migration flips the default.**

**Restart.** All N conversations lose their transport session at once. Recovery is per-client,
lazy, and independent: it fires on that conversation's _next_ tool call, not at t=0, so agent turn
timing staggers it naturally — there is no thundering herd at the moment of restart. The spike
measured **one** client recovering in 38ms/47ms; N-client recovery is **UNVERIFIED** and is
explicitly not claimed here. The one real exposure is cold start (~5.1s median): a tool call
issued during the restart window fails and retries, and the retry is the recovery path — but
whether that holds at N=10+ concurrent re-inits is exactly what has not been observed. mt#3811
measures it before the default flips.

**`MAX_HTTP_SESSIONS`.** Currently `null` (uncapped) by default. Leave it uncapped locally. A cap
sized to expected conversation count would be wrong: Observation D shows conversations mint
_more_ transport sessions than there are conversations, so a "40 conversations → cap 40" reading
under-provisions and returns 503s to healthy clients.

**Idle reaper.** `SESSION_IDLE_TIMEOUT_MS` defaults to 2h — tuned for the hosted deployment where
a disconnect is ambiguous. Locally the shim's process exit is a reliable disconnect signal, so the
local daemon should reap far more aggressively (a value on the order of minutes, set via
`MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS`), and the shim should issue an explicit `DELETE` on the
session at shutdown. Without this, 40 abandoned conversations pin 40 per-session `Server`
instances for two hours.

**The genuinely new risk, stated plainly.** Today a pathological tool call — an OOM, an
event-loop stall, a runaway query — degrades exactly one conversation. Under a shared daemon it
degrades all N. Supervisor respawn plus transparent client re-init bounds the _duration_, not the
_width_. This is the cost of consolidation and it is not mitigated away by anything in this ADR;
it is accepted.

---

## Question 7 — Migration, coexistence, rollback

**Decision: `minsky setup local-http` performs a `command`/`args` swap inside the existing
`type: "stdio"` entry, under a new server name, with a backup and an idempotent re-run.**

The shim topology makes this materially smaller than a transport migration would have been. The
Claude Code entry stays `type: "stdio"`; only what gets spawned changes:

```
before:  command: minsky   args: [mcp, proxy]
after:   command: minsky   args: [mcp, shim, --url, http://127.0.0.1:48765/mcp]
```

- **Idempotent + backed up.** The command backs up the config with a timestamp before writing and
  is safe to re-run; a second run against an already-migrated config is a no-op.
- **Coexistence.** The old `minsky mcp proxy` entry and the new shim entry can be registered under
  different server names simultaneously during the transition. They do not interfere — the proxy
  spawns its own inner server, the shim talks to the daemon.
- **Rollback is one command.** `minsky setup local-http --revert` restores the backup and stops
  the daemon; a conversation restarted after that is back on today's topology exactly. Per
  `decision-defaults.mdc §Turnkey, not portal`, the revert is a command, not a documented
  hand-edit.
- The daemon must be running before the migration is useful, so `setup local-http` registers the
  daemon with the tray supervisor (Question 3) as part of the same command rather than leaving
  the operator to start it.

---

## Question 8 — Decomposition

Four implementation subtasks are filed under mt#1713, each with its own spec, implementable
without re-deriving this ADR's reasoning:

| Task        | Deliverable                                                                                                                                                 | Depends on                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **mt#3812** | `minsky mcp shim` — the thin stdio→HTTP bridge, with the identity-injection semantics and the RSS-thinness constraint that the whole resource case rests on | —                         |
| **mt#3814** | Daemon lifecycle: fixed port + identity-asserting conflict detection, discovery file, bearer token, local idle-reaper tuning                                | —                         |
| **mt#3815** | Generalize the tray supervisor from one hardcoded daemon to a registry of N; register the MCP daemon (absorbs mt#2427 if unstarted)                         | —                         |
| **mt#3816** | `minsky setup local-http` — idempotent config swap, coexistence, one-command revert                                                                         | mt#3812, mt#3814, mt#3815 |
| **mt#3811** | Measure daemon RSS at N sessions and N-client restart recovery; gates the default flip and fills the two figures this ADR leaves unmeasured                 | mt#3812, mt#3814          |

mt#3811 is not optional polish: §Question 1's resource table and §Question 6's shared-fate argument
both carry claims this ADR explicitly declines to make, and mt#3811 is where they get made or
falsified. The migration default should not flip ahead of it.

---

## Consequences

**Easier**

- Conversation identity is preserved with **zero change** to ADR-006, the `_meta` contract, or any
  consumer of it. The injection point moves from the proxy to the shim; the payload is identical.
- Migration is a config `args` swap, not a transport change — smaller blast radius, trivially
  reversible.
- One place to attach a debugger, one log stream, one DB pool, one disconnect-tracker state.
- The post-merge rebuild latency the proxy currently pays per conversation is paid once.

**Harder / newly committed**

- Only ~50% of the available resource win is realized. If the daemon's own footprint at N=40 turns
  out to be large, the margin narrows further — hence mt#3811.
- A new process class to build and maintain (the shim) that must stay genuinely thin. The measured
  ~38MB is the Bun floor; importing anything from the Minsky bundle would put it back on the
  ~55MB proxy's trajectory and erase the win. This is a standing constraint on the shim, not a
  one-time check.
- Blast radius widens from one conversation to N for any daemon-level fault.
- The tray supervisor grows from one daemon to a registry — new correctness surface, per ADR-014's
  own "two lifecycle paths must not fight over the port" warning, now multiplied.

**Left unverified, deliberately**

- N-client recovery after a daemon restart (only N=1 measured).
- Daemon RSS at N=40 concurrent sessions.
- The interactive (non-`sdk-cli`) Claude Code transport's header set. Shared implementation makes
  divergence unlikely; it was not captured.

## Alternatives rejected

**Direct HTTP with degraded identity.** Twice the resource win. Rejected because the degradation
is not graceful: per Observation D the only available fallback key churns within a conversation
and resets on daemon restart, so presence, dispatch attribution, and attention accounting would
receive _unstable_ identity rather than coarse identity — worse than none for anything that
aggregates.

**Direct HTTP with identity injected via a `${CLAUDE_CODE_SESSION_ID}` config header.** Measured
and falsified (Observation E): the expansion resolves ambient environment, not the conversation,
and fails silently to a literal when unset.

**Direct HTTP with identity recovered via the `roots/list` callback.** The client declares
`roots: {listChanged: true}`, so the daemon could ask for workspace roots. Rejected on grain: that
yields the _directory_, and multiple conversations routinely share one. It is not conversation
identity.

**One unified cockpit+MCP daemon.** Rejected in Question 2 — couples independent failure domains
and auth postures to save one process baseline.

**Unix domain sockets.** Ruled out upstream: the client rejects the scheme (mt#3766).

## References

- mt#1713 — parent RFC; July 2026 decision package; 2026-08-05 process census.
- mt#3766 / `docs/mcp-http-daemon-spike-findings.md` — Phase-1 spike (session-ID invalidation
  PASS, cold start ~5.1s, unix sockets rejected, OAuth auto-wire side-finding).
- mt#3764 — HTTP-mode orphan self-exit on ppid→1; composes with tray supervision (Question 3).
- ask#7151 — operator chose the full build (2026-08-06).
- ADR-006 — agent identity scheme; Layer 3 is what Question 1 protects.
- ADR-014 — tray as canonical supervisor of the cockpit daemon; Question 3 generalizes it.
- ADR-022 — workspace / conversation / transport-session vocabulary used throughout.
- mt#2427 — tray configurable-port supervision; **extended** by Question 3.
- mt#2141 — closed as superseded; its surviving question is answered in Question 2.
- `docs/architecture/stdio-proxy.md` — the identity-injection mechanism the shim inherits.
- `src/mcp/stdio-proxy/conversation-identity.ts` — `injectAgentIdMeta`.
- `src/mcp/server.ts` — `httpSessions`, `MAX_HTTP_SESSIONS`, `SESSION_IDLE_TIMEOUT_MS`.
