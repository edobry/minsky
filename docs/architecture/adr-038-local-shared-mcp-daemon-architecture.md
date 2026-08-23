# ADR-038: Local shared MCP daemon — keep a thin per-conversation shim, because the HTTP transport carries no conversation identity

## Status

**Accepted** — 2026-08-06. Decided under mt#3808, the Phase-2 design step of mt#1713. Approved by
the operator twice (ask#7151 — full build; ask#7273 — build it, measure a compiled shim first),
and its first component has shipped and merged (mt#3812, PR #2820 — `minsky mcp shim`).

**Update, 2026-08-09 (mt#3884):** the ~38MB shim figure below was measured against a Bun-based
prototype; mt#3884 measured a minimal Rust equivalent of the same job at ~2.9–3.4MB — ≈12x
smaller, confirming the ~38MB was mostly the interpreted runtime's floor rather than the shim's
own work. The resource table and the "gives up roughly half" framing are updated below with both
figures; the runtime recommendation to mt#3812 (stay on Bun for v1) follows the table. See
`docs/mcp-http-daemon-spike-findings.md` §Rust shim measurement for the full method and raw
samples.

## The call

**Put the shared daemon behind a thin per-conversation stdio→HTTP shim rather than pointing
Claude Code at the daemon directly — because a direct HTTP connection carries no per-conversation
identifier by any route, and the shim recovers it for the price of a ~38MB byte-pipe in the
Bun/TypeScript runtime mt#3812 will actually ship (a compiled Rust equivalent measures ~3MB —
see the 2026-08-09 update above and §Question 1's runtime recommendation for why Bun is still the
call).**

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

That is essentially the Bun runtime floor — confirmed, not just suspected, by mt#3884
(2026-08-09): a Rust equivalent of the identical job (stdin line reader, `_meta` stamp, HTTP
forward, stdout writer — same scope, no GET/SSE proxying either) was driven through the live
daemon by a real `claude -p` client, with the `_meta["io.minsky/agent_id"]` stamp verified
present at the daemon on every `tools/call`. Nine `ps` samples, ~2-3s apart, while the client held
the connection open:

```
2.976 MB   2.976 MB   2.976 MB   2.976 MB   3.152 MB   3.152 MB   3.152 MB   3.152 MB   3.392 MB
```

**~2.9–3.4 MB, settled — ≈12x smaller than the Bun figure above.** Full method, the identity-stamp
capture, and cleanup verification: `docs/mcp-http-daemon-spike-findings.md` §Rust shim
measurement.

### Revised resource win, against the census baseline

The mt#1713 baseline is **~40 pairs, ~3.4 GB**.

| Topology                             | Per-conversation cost | ~40 conversations                 | vs baseline    |
| ------------------------------------ | --------------------- | --------------------------------- | -------------- |
| Today (proxy + inner server)         | ~119 MB               | ~3.4 GB (baseline)                | —              |
| Thin shim (Bun) + shared daemon      | ~38 MB                | ~1.5–1.8 GB, measured             | ≈ -48% to -50% |
| **Thin shim (Rust) + shared daemon** | **~3.2 MB**           | **~0.385 GB, measured (mt#3884)** | **≈ -89%**     |
| Direct HTTP + shared daemon          | 0                     | one daemon (~0.1–0.25 GB)         | ≈ -95%         |

**Daemon RSS at N sessions — measured by mt#3811 (2026-08-08), no longer unmeasured.** Driving
N=1/5/10 concurrent HTTP-connected clients against one daemon and sampling `ps` RSS repeatedly at
each step found **no growth signal distinguishable from noise**: settled-window medians were
~110 MB (N=1), ~170 MB (N=5), ~104 MB (N=10) — non-monotonic, because at this N range `ps` RSS on
the daemon's Bun process is dominated by GC/allocator burst-and-decay following recent connection
churn (independently confirmed: the identical 86–170 MB band reappears with **zero** clients
connected, purely from a prior burst decaying), not by concurrent session count. All 30 in-session
samples across N=1/5/10 fall in an 84–257 MB band. Taking the single highest sample observed
(~257 MB) as a deliberately pessimistic per-daemon estimate, the shim topology's total at ~40
conversations is `~38 MB × 40 + ~257 MB ≈ 1.78 GB` — **≈ -48%**, materially unchanged from the
≈ -50% estimate this table already carried before the daemon term was filled in. The daemon was
never the reason the shim topology gives up roughly half of direct HTTP's win — the shim's own
~38 MB/conversation floor (measured separately, above) is what accounts for that gap, and this
measurement does not touch that number. Full methodology, all raw samples, and the two
companion restart-recovery experiments:
`docs/mcp-http-daemon-spike-findings.md` §N-scale measurement.

Stated plainly (as of the 2026-08-06 Bun-only measurement): **choosing the shim gives up roughly
half of the available win.** It is still a real win — the shim costs ~32% of today's pair, and
~60% of today's inner server alone — and it buys back the whole identity layer. But the ADR
should not pretend the two options are close on resources.

**Revised, with the Rust figure (mt#3884, 2026-08-09): a compiled shim gives up a few percentage
points, not half.** ≈-89% vs direct HTTP's ≈-95% is a 6-point gap, not a 45-point one. The
"conversation identity costs half the win" framing above was true of the Bun prototype and is not
true of the shim's job in general — see the runtime recommendation immediately below for whether
that changes what mt#3812 should actually build.

### Runtime recommendation to mt#3812

The Rust figure is real and was verified end-to-end (§ above), not inferred from the Bun number.
It does not settle the runtime choice by itself — mt#3812 must also weigh what the RSS number
leaves out:

- **Distribution, not just compilation.** `cockpit-tray/src-tauri/` gave this measurement a
  working Rust toolchain for free, but that toolchain solves _building_ a binary on one machine.
  The shim's job (per the Decision below) is to be spawned by Claude Code on **every developer's
  own machine**, not shipped once to the operator's own tray install. That means a codesigned,
  notarized, versioned binary has to reach and stay current on N machines the project does not
  control the update cadence of — a materially different problem than cockpit-tray's own
  single-operator Tauri bundle-and-notarize pipeline, which this measurement did not have to
  stand up or solve.
- **A second language in a correctness-sensitive path.** `_meta["io.minsky/agent_id"]` injection
  is ADR-006 Layer-3 identity — the join key presence claims, dispatch attribution, and
  transcript↔workspace correlation depend on. Today it lives in TypeScript
  (`src/mcp/stdio-proxy/conversation-identity.ts`) alongside the rest of the codebase. A Rust
  shim moves this logic into a second language that the same engineers maintaining everything
  else now also have to carry — for a project explicitly run by one engineer
  (`principal-context.mdc`: "engineering time is the scarce resource").
- **The gap is not closed, it is narrowed, and there is already a scoped follow-on feature.**
  mt#3811 found a real cold-start-window exposure (a call landing while the daemon is down gets a
  hard failure, not a transparent retry) and scoped its fix — retry-with-backoff — into "mt#3812's
  shim." That logic would need writing, testing, and maintaining twice if the shim's runtime and
  the rest of the stack diverge, or maintained only in Rust by whoever is willing to context-switch
  into it.
- **Absolute, not just proportional, savings.** ~38MB → ~3.2MB is a large proportional win but a
  modest absolute one at this N: ~35MB/conversation, ~1.4GB total at the census's ~40
  conversations (1.78GB → 0.385GB). The Bun-shim topology was already the headline win over
  today's ~3.4–5.7GB; the additional 1.4GB a Rust rewrite buys back is real but is not, by itself,
  an obviously worthwhile trade for permanent cross-compilation/distribution/maintenance
  infrastructure on a solo-engineered product.

**Recommendation: stay on Bun for mt#3812's v1 shim.** The measured ~38MB/conversation cost is
small in absolute terms (≈1.5–1.8GB total at ~40 conversations, already a ≈48–50% win over today),
ships in the same bundle and language as the rest of the project, and needs no new distribution
pipeline — the "command/args swap" migration path the Decision below describes stays exactly that
simple. This is a genuinely close call, not a lopsided one, and the condition under which it
flips is nameable — ~~if the daemon topology ever centralizes~~ **(superseded 2026-08-11, see
`## Amendment (2026-08-11)` below: shims are client-side, one per conversation, wherever
conversations run; daemon centralization does not concentrate their cost)**. The corrected
trigger is **conversation-host consolidation** — a hosted fleet running many conversations on one
machine, or a customer footprint complaint attributable to the shims: the per-conversation shim
cost multiplies at a much larger N of co-located conversations, and the ~35MB/conversation
difference stops being 1.4GB and starts being the dominant term. That is not this architecture
today — ADR-038 §Question 2 keeps the daemon local and per-developer, and no hosted
conversation-host consolidation is planned — so the condition does not apply today, but it is
worth naming so a future re-litigation of this call starts from evidence instead of re-running the
same measurement.

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

**Decision: a static bearer token, generated at setup, stored `0600` at
`~/.config/minsky/local-mcp-token`, held by the daemon and the shim. It is NEVER written into the
Claude Code MCP config.**

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

**A constraint on any future direct-HTTP escape hatch — not on the primary path.** Should a
direct-HTTP route ever be added, it would have to put the credential in the client config, since
there is no shim to hold it. Two things follow, and both argue against that route rather than for
a config-file token. First, `${VAR}` templating does not work as a way to keep the secret out of
the file: Observation E measured that `${VAR}` in an HTTP MCP entry expands against the ambient
environment and, when the variable is unset, sends the literal `${CLAUDE_CODE_SESSION_ID}` string
with no error — so it fails as a confusing `401` rather than a clear misconfiguration. Second, the
only alternative it leaves is a plaintext token in a config file that is not mode-`0600` and is
routinely copied, diffed, and shared — which is precisely why the shim path is the decision above
and this remains hypothetical. Record the constraint so it is not rediscovered.

---

## Question 6 — Shared fate and blast radius

**Decision: accept shared fate for the restart path, which is measured and cheap; treat the
poison-request path as the real new risk and cap it with the existing idle reaper plus a
measurement subtask before the migration flips the default.**

**Restart.** All N conversations lose their transport session at once. Recovery is per-client,
lazy, and independent: it fires on that conversation's _next_ tool call, not at t=0, so agent turn
timing staggers it naturally — there is no thundering herd at the moment of restart. The spike
measured **one** client recovering in 38ms/47ms.

**mt#3811 (2026-08-08) measured N-client recovery: confirmed, for the case where the daemon is
already back up.** 6 concurrent clients, each with a live session, all recovered transparently in
8–14ms with zero surfaced failures when the daemon restart completed before each client's next
call fired — the lazy-reinit claim above holds at N=6.

**The cold-start window is a real exposure, not a hypothetical one — and the recovery framing
above needs a correction.** "A tool call issued during the restart window fails and retries, and
the retry is the recovery path" undersells what mt#3811 observed: when a client's call actually
lands while nothing is listening (the ~5.1s median cold-start gap, as opposed to the
already-back-up case above), the failure surfaces immediately into the model's turn — there is no
automatic client-side retry/backoff for this failure class, unlike the stale-session case. Recovery
then depends on **agent-level** retry behavior, which is not guaranteed: in the measured run the
agent retried once, then stopped (its own 2-strikes-style discipline) and surfaced the failure to
the user rather than continuing to retry. At N-way concurrency, any client whose call happens to
land inside a restart's ~5s window will see this, not a staggered-and-silent recovery. This should
be an explicit requirement for Phase 2 (mt#3812's shim, or the supervisor in mt#3814/mt#3815) —
e.g. retry-with-backoff specifically around connection-refused — rather than assumed to come free.
Full experiment detail: `docs/mcp-http-daemon-spike-findings.md` §N-scale measurement, Experiment 3.

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

| Task        | Deliverable                                                                                                                                                                                                                  | Depends on                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **mt#3812** | `minsky mcp shim` — the thin stdio→HTTP bridge in **Bun/TypeScript** (runtime choice settled by mt#3884, below), with the identity-injection semantics and the RSS-thinness constraint that the whole resource case rests on | —                         |
| **mt#3814** | Daemon lifecycle: fixed port + identity-asserting conflict detection, discovery file, bearer token, local idle-reaper tuning                                                                                                 | —                         |
| **mt#3815** | Generalize the tray supervisor from one hardcoded daemon to a registry of N; register the MCP daemon (absorbs mt#2427 if unstarted)                                                                                          | —                         |
| **mt#3816** | `minsky setup local-http` — idempotent config swap, coexistence, one-command revert                                                                                                                                          | mt#3812, mt#3814, mt#3815 |
| **mt#3811** | ~~Measure daemon RSS at N sessions and N-client restart recovery~~ — **DONE, 2026-08-08**: both figures are now measured and folded into §Question 1 and §Question 6 below                                                   | —                         |
| **mt#3884** | ~~Measure a compiled (Rust) shim's footprint before mt#3812 picks a runtime~~ — **DONE, 2026-08-09**: ~2.9–3.4MB measured end-to-end vs Bun's 36.0–38.6MB; recommendation is to stay on Bun for v1 (§Question 1)             | gates mt#3812             |

mt#3811 was not optional polish: §Question 1's resource table and §Question 6's shared-fate
argument previously carried claims this ADR explicitly declined to make, and mt#3811 is where they
were made — driven directly against the daemon over HTTP, since the shim (mt#3812) was not yet
built and neither measured quantity depends on it. Both sections now carry the measured numbers.

mt#3884 closes the other open question in §Question 1: whether the ~38MB shim figure was the Bun
runtime's floor or the shim's own job. It was the runtime's floor — a compiled equivalent of the
identical job measured ~12x smaller — but the runtime recommendation is still to build mt#3812 in
Bun/TypeScript, not Rust, per the weighing in §Question 1's "Runtime recommendation to mt#3812."

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

- ~48–50% of the available resource win is realized with the Bun shim mt#3812 will actually ship
  (the recommended runtime, per §Question 1) — not the ≈-89% a compiled shim measured in mt#3884
  would reach. The choice to stay on Bun trades some of that closed gap back for staying in one
  language and needing no new binary-distribution pipeline; see §Question 1's runtime
  recommendation for the full weighing.
- A new process class to build and maintain (the shim) that must stay genuinely thin. The measured
  ~38MB is the Bun floor; importing anything from the Minsky bundle would put it back on the
  ~55MB proxy's trajectory and erase the win. This is a standing constraint on the shim, not a
  one-time check.
- Blast radius widens from one conversation to N for any daemon-level fault.
- The tray supervisor grows from one daemon to a registry — new correctness surface, per ADR-014's
  own "two lifecycle paths must not fight over the port" warning, now multiplied.

**Left unverified, deliberately**

- The interactive (non-`sdk-cli`) Claude Code transport's header set. Shared implementation makes
  divergence unlikely; it was not captured.
- Daemon RSS at exactly N=40 concurrent sessions (the census's actual scale). mt#3811 measured
  N=1/5/10 directly and found no growth signal above ~90 MB of noise across that range — see
  §Question 1 — which supports extrapolating a small daemon term to N=40, but N=40 itself was not
  directly driven.

**Resolved by mt#3811 (2026-08-08)** — previously listed here as unverified:

- ~~N-client recovery after a daemon restart (only N=1 measured)~~ — measured at N=6. Transparent
  (8–14ms, zero surfaced failures) when the daemon is already back up by the client's next call;
  a hard, model-surfaced failure with no guaranteed recovery when the call lands in the cold-start
  gap itself. See §Question 6.
- ~~Daemon RSS at N concurrent sessions (the general shape)~~ — measured at N=1/5/10; see
  §Question 1.

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

## Amendment (2026-08-11)

This amendment records three corrections identified by an independent review dated 2026-08-10 and
verified against primary sources by the dispatching agent (mt#3974). It does not change the
architecture — the design decided above is unchanged and shipped (mt#3812, merged, PR #2820). It
corrects the durable record so a future reader inherits accurate reasoning rather than re-deriving
it.

### 1. The MCP 2026-07-28 statelessness revision — absent from the original record, and it cuts both ways

The MCP specification's [2026-07-28
revision](https://modelcontextprotocol.io/specification/2026-07-28/basic/index) (read directly,
not paraphrased) declares MCP a stateless protocol. Its `## Statelessness` section reads,
verbatim:

> The Model Context Protocol (MCP) is a **stateless protocol**: all the information needed to
> process a request is contained in the request itself. A server processes each request
> independently; no state should be inferred from previous requests, even those on the same
> connection or stream.
>
> Specifically:
>
> - Servers **MUST NOT** rely on prior requests over the same connection to establish context
>   (e.g., capabilities, protocol version, client identity). Every request supplies this metadata
>   in its `_meta` field.
> - Servers **SHOULD** be prepared to handle requests associated with multiple tasks, threads, or
>   conversations.
> - Servers **SHOULD NOT** require that a client reuse the same connection or process to perform
>   related operations.
> - Clients **SHOULD NOT** use an individual task, thread, or conversation as the lifetime
>   boundary for the stdio process.
> - State that needs to span multiple requests (e.g., long-running tasks, application-level
>   handles) **MUST** be referenced by an explicit identifier the client passes on each request.

and, in a `<Note>` callout immediately beneath the bullets:

> This implies that an open connection, such as a STDIO process, is not a conversation or
> session: clients may interleave unrelated requests on the same transport, and a server must not
> treat connection or process identity as a proxy for conversation or session continuity.

**Both halves matter, and they point in opposite directions for this ADR.**

The last bullet — state spanning multiple requests "MUST be referenced by an explicit identifier
the client passes on each request" — is exactly what the shim does. `_meta["io.minsky/agent_id"]`
is precisely that explicit, per-request identifier. This is a _stronger_ argument for the shim's
**mechanism** than anything in the original record: the design is not merely compatible with the
protocol, it is the pattern the protocol's own normative text prescribes for exactly this
problem.

The `<Note>` is the opposite argument, and it targets the shim's **justification**, not its
mechanism. The original decision text (§Question 1) derives conversation identity from process
lifetime: Claude Code spawns one stdio process per conversation, so `CLAUDE_CODE_SESSION_ID` on
that process names the conversation, therefore the shim can trust it. The Note says a server
"must not treat connection or process identity as a proxy for conversation or session
continuity" — which is exactly that inference, made client-side rather than server-side, but the
same inference the revision tells implementations to stop relying on. The shim works today
because Claude Code's _current_ spawn behavior — literally one process per conversation — is a
real, observed fact (§Question 1, Observation F), not a protocol guarantee the spec extends to
implementations. The 2026-07-28 revision does not forbid the shim from working; it forbids
treating _why_ it works as durable.

**Right answer, expiring reason.** The mechanism the shim uses (an explicit per-request
identifier) is the direction the protocol is moving toward. The premise the shim's design rests
on (process identity ≈ conversation identity) is the direction the protocol is moving away from.
Nothing in this ADR needs to change today — Claude Code's current sdk-cli behavior still holds,
as measured in §Question 1 — but the day it stops holding, this should not be a surprise: the
Follow-ups already on file (identity-reader ordering, `baggage` emission, fallback logging — see
Context in the originating task spec, mt#3974) are exactly the mitigation for this expiring
premise, not incidental hardening.

### 2. Rewrite trigger corrected

§Question 1's "Runtime recommendation to mt#3812" named the rewrite trigger as daemon
centralization. That was wrong: shims are client-side, spawned one per conversation regardless of
what the daemon looks like, so daemon topology does not change their aggregate cost. The
correction is now inline at that location, with the original wording left visible and marked
superseded rather than silently rewritten — this ADR is already amended once (2026-08-09,
above) and readers need the sequence. The actual trigger is **conversation-host consolidation** —
a hosted fleet running many conversations on one machine, or a customer footprint complaint
attributable to the shims. (This correction was first recorded on mt#3812's spec; this amendment
propagates it to the durable record.)

### 3. The resource framing was misleading; identity + consolidation is the operative motivation

With a Bun shim, the shim fleet is now measured at **~34MB per conversation on the shipped
`minsky mcp shim` invocation** (mt#3812, merged, PR #2820 — the entry-point split), against
today's 55.5MB proxy (§Question 1's live census, above). At the ADR's own ~40-conversation census
scale, the shim fleet alone is ~1.36GB of the new topology's total footprint — roughly 85% of it,
once the single shared daemon (measured ~84–257MB, §Question 1's N-scale table) is added. The
original record's resource win was already computed on the shim's per-conversation cost, not the
daemon's, and this shipped number confirms that: shrinking the daemon further would not move the
topology's footprint much, because the daemon was never where the mass is.

That means "resource usage" has quietly stopped being this architecture's motivation. This was
already true in the original record's own numbers (§Question 1: "the daemon was never the reason
the shim topology gives up roughly half of direct HTTP's win — the shim's own ~38MB/conversation
floor... is what accounts for that gap"). What has changed since then is that the shipped
invocation confirms the shim's floor at the number that matters — the actual binary mt#3812 built
and merged — rather than a standalone prototype's.

**The shipped-invocation figure is a different measurement from the standalone-prototype figures
already in the resource table above, and the two should not be conflated:**

| Figure                          | What it measures                                                                                                                         | Source                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| ~38MB (Bun) / ~2.9–3.4MB (Rust) | A minimal standalone prototype: no Minsky imports, no command registry, no DB — built to answer "what is the runtime floor," not shipped | §Question 1 above; mt#3884       |
| **~34MB**                       | The real `minsky mcp shim` binary as merged and shipped, after mt#3812's entry-point split                                               | mt#3812, merged, PR #2820        |
| 55.5MB                          | Today's `minsky mcp proxy` — the full Minsky bundle, the process the shim replaces                                                       | §Question 1's live census, above |

The shipped figure lands close to the Bun prototype's floor (~34MB vs ~38MB), which is itself
confirmation that the entry-point split did its job: the real shim did not drag in the bundle the
way the 55.5MB proxy does.

**What this ADR's motivation actually is.** Not resource reclamation — the shim gives back
roughly a third of a proxy process, and it is now the majority of the new topology's own
footprint. The actual case for this design, restated plainly: **identity preservation** (ADR-006
Layer-3 conversation identity has no other route over HTTP — §Question 1's Decision) and
**consolidation** (one daemon instead of N inner-server processes; one place to attach a
debugger, one log stream, one DB pool — §Question 1's Decision, §Question 2's Consequences). The
resource case is real but secondary, and the original record's headline framing overstated it.

### Forward-looking note: the terminology already matches the field's units, but the key is misnamed

ADR-022's workspace / conversation / transport-session split does not need new vocabulary to
describe what this ADR's `_meta` field carries — the field's own units already match
OpenTelemetry's GenAI semantic conventions: `mcp.session.id`, `gen_ai.conversation.id`, and
`gen_ai.agent.id` name exactly the three concepts ADR-022 already distinguishes (transport
session, conversation, and agent, respectively).

What is worth recording is a naming inversion, not a missing concept: Minsky's `_meta` key is
named `agent_id` (`_meta["io.minsky/agent_id"]`) while the value it carries is a **conversation**
id — the inverse of OTel's usage, where `gen_ai.conversation.id` names the conversation and
`gen_ai.agent.id` names something else entirely (the agent definition/persona, not a
conversation). Anyone integrating Minsky's identity scheme with OTel-instrumented tooling should
expect this inversion rather than assume the key names line up with what they hold. This is an
observation for future integration work, not a rename — `agent_id` is ADR-006's own established
key and changing it is out of scope here.

## Amendment (2026-08-22) — the shim is one-directional, and that is now explicit

This ADR's Question 1 records a capture of Claude Code's `initialize` params
(§"Observation B") showing `"capabilities": { "roots": { "listChanged": true },
"elicitation": {} }`. What it did not draw out is the consequence of forwarding that
declaration through a shim that **cannot carry a server-initiated request**.

The shim reads a line from stdin, POSTs it, and writes the responses back
(`src/mcp/shim/main.ts`, `client.ts`). It opens no GET/SSE stream, holds no correlation
table for a server→client request, and reads the response body with a fully-buffering
`await response.text()`. A server request sent inside the response stream therefore
cannot surface until the stream closes, and the stream cannot close until the request
is answered — a deadlock by construction rather than a race.

**mt#4450 is the incident this produced.** MCP elicitation is a server-initiated
request; the ask router honored the forwarded declaration; every `direction.decide` ask
dispatched to the elicitation transport and blocked the calling agent for up to five
minutes before failing. Two consequences beyond the stall: the ask persisted with a
NULL `routingTarget`, which the cockpit inbox filters on, and agents retried, minting
duplicate asks ~5m30s apart.

Two changes follow, and both belong to this ADR's topology rather than to the ask
subsystem that surfaced them:

1. **The shim narrows the declared capability set** (`src/mcp/shim/capabilities.ts`),
   removing `elicitation`. A capability declaration describes a CONNECTION; through this
   one, elicitation is not supported. The narrowing is minimal on purpose — `sampling`
   and `roots` are structurally identical but uncalled here, so they stay declared until
   a real call site justifies otherwise.
2. **A single in-flight POST carries an explicit 600 s bound** (`REQUEST_TIMEOUT_MS`),
   sized above the measured 150–315 s `session_commit` band so it cannot kill a working
   call. Previously such a request rode an undocumented runtime default. The timeout is
   classified ahead of the connection-refused classifier, which treats every network
   throw as retryable and would otherwise report an accepted-then-unanswered request as
   "daemon unreachable" — the opposite diagnosis.

**Consequence for future work on this topology:** anything that adds a server-initiated
MCP request (`roots/list`, `sampling/createMessage`, a future protocol addition) is
unreachable across the shim as built. Either teach the shim to carry them — a GET/SSE
stream plus request correlation, which is the change that would let capability 1 be
reverted — or keep the feature off the local path. This is a property of the topology
this ADR chose, not of the feature that trips over it.

Separately, `MCPClientCapabilityRegistry` resolved capabilities for the daemon PROCESS
rather than for the calling connection — correct under the pre-ADR-038 one-server-per-
conversation topology this document replaced, and wrong under consolidation. **Fixed by
mt#4451** (2026-08-23): capabilities are now resolved per CallTool request from the
connection that made the call (`SingleConnectionCapabilityRegistry`), and the fleet-wide
class survives as `MCPConnectionTracker` for diagnostics only. It is recorded here
because it was a direct consequence of this ADR's decision, and the sequence is the
lesson: consolidating the topology silently invalidated a correctness assumption held by
code that was never touched.

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
