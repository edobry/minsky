# ADR-041: The local MCP daemon owns local persistence behind a gateway that callers can always fall back past

## Status

**Proposed** — 2026-08-14. Decided under mt#2430, whose deliverable was set by ask#8467 ("Short
ADR, then subtasks") after ask#7665 declined the RFC that would have re-weighed buy-vs-build.

**Proposed is a merge-able state in this corpus** — ADR-037 and ADR-040 are both on main in it,
ADR-040 as of 2026-08-13. Acceptance is a separate operator step on the merged document, recorded
in this Status line when it happens (the pattern ADR-038 §Status shows). mt#2430's success criteria
were amended on 2026-08-14 to say so explicitly.

Two prior operator decisions bind this ADR and are not re-opened here: **ask#7583** — the shared
local MCP daemon (ADR-038), not the cockpit daemon and not a third process, is the owner;
**ask#7665** — build it rather than benchmark a localhost connection pooler first.

## The call

**Give the shared local MCP daemon a narrow, loopback-only persistence gateway, and require every
caller to fall back to its existing direct connection when the gateway is unreachable — so the
daemon is a latency optimization that can be turned off, never a dependency that can take the
fleet down.**

- A cold hook stops paying a 2.3–2.6s TLS/TCP handshake per fire; the daemon pays it once.
- Nothing breaks when the daemon is absent, restarting, or disabled — callers degrade to today's
  behavior, which already works.
- The gateway exposes **domain operations**, not SQL, so ADR-002's provider abstraction stays the
  only way to reach the database.
- PGlite becomes topologically possible for the first time, and is still not authorized —
  ADR-027 gates it at mt#434.
- The hosted deployment is untouched: Supavisor already multiplexes there, so the owner is a
  **local-only** optimization.

Accepting this ADR means agreeing with that call. The seven questions below are its reasoning.

## Context

### What it costs to reach the database from a hook today

Every hook fire is its own OS process. It inherits nothing from the harness: it installs the
tsyringe reflect polyfill, initializes the domain configuration system
(`ensureHookDomainBootstrap`, `.minsky/hooks/domain-bootstrap.ts`), and then opens a fresh
Postgres connection through `resolvePersistenceProviderOrError()`.

Measured from a cold hook-shaped process against the hosted Supavisor endpoint (mt#3090, recorded
on mt#2430's `## Demand signal`):

| Stage                               | Cost                           |
| ----------------------------------- | ------------------------------ |
| DNS                                 | 6–353ms                        |
| TCP                                 | 866–1016ms                     |
| TLS                                 | 1406–1735ms                    |
| **socket subtotal**                 | **2.3–2.6s**                   |
| full `resolvePersistenceProvider()` | 3.3–3.7s warmed, 4.3–5.5s cold |

None of that work is reusable. The process exits immediately afterward and the next fire repeats
it. This is the cost the ADR exists to remove, and `domain-bootstrap.ts`'s own doc comment already
names this topology as the structural fix — the 2s connect timeout removed in mt#3879 was a
symptom-level attempt at the same problem, and it made things worse: the cap sat below the floor,
so every DB-backed hook failed open deterministically for weeks.

### What already exists

ADR-038 shipped the daemon and, deliberately, two primitives for exactly this consumer:

- `~/.local/state/minsky/local-mcp.json` — port, pid, started-at. Its format is explicitly
  constrained so a **non-MCP local consumer** can read it (`src/mcp/daemon/local-daemon.ts:61,77`).
- `~/.config/minsky/local-mcp-token` — a `0600` bearer token (`src/mcp/shim/token.ts:6`).

The daemon listens on a fixed loopback port (`48765`, `DEFAULT_LOCAL_DAEMON_PORT`) bound to
`127.0.0.1`. Both primitives are merged and in use.

## Question 1 — the client seam

**Decision: plain loopback HTTP against the existing daemon, authenticated with the existing file
token, carrying a request body. Not MCP, and not a new transport.**

The reason this is simpler than it looks is worth stating, because it is the one place this design
gets to be cheaper than ADR-038's: **the constraint that forced ADR-038's shim does not apply to
these callers.** ADR-038 put a per-conversation stdio→HTTP shim in front of the daemon because a
real Claude Code client sends nothing conversation-scoped over HTTP — not in headers, not in
`initialize` params, not in `tools/call` `_meta` — so conversation identity had to be recovered
out-of-band. A hook is a different kind of client: it is handed its payload on stdin, session id
included, and can put identity in the request body explicitly. It needs no handshake, no session,
and no shim.

So the gateway is an ordinary authenticated POST, not an MCP session. Callers discover the port
from the discovery file, read the token from its `0600` path, and issue one request. Both are
existing exported helpers, not new surface: `localDaemonDiscoveryPath()` and
`readDiscoveryRecord()` (`src/mcp/daemon/local-daemon.ts:78,214`) for the former,
`localDaemonTokenPath()` / `DEFAULT_TOKEN_PATH` (`src/mcp/daemon/local-daemon.ts:88`, re-exported
from `src/mcp/shim/token.ts`) for the latter, against
`DEFAULT_LOCAL_DAEMON_PORT = 48765` / `DEFAULT_LOCAL_DAEMON_HOST = "127.0.0.1"`
(`src/mcp/daemon/local-daemon.ts:53,56`).

**Round-trip budget: p95 under 50ms per gateway call**, against the 3.3–5.5s the same work costs
today. The budget is deliberately loose relative to what loopback HTTP can do — it is a ceiling
that must hold with the daemon's query time included, not a target for the transport. A caller
that exceeds it should fall back rather than wait (Question 2).

**Confidence:** the 50ms figure is `inferred` — a bound chosen against the measured 2.3–2.6s it
replaces, not a measurement of this gateway, which does not exist. The first implementation
subtask owes the measurement, and this ADR should be amended if the real number lands near it.

## Question 2 — restart and crash semantics

**Decision: the gateway is never load-bearing. Every caller keeps its existing direct-connect path
and uses it whenever the gateway is unreachable, slow, or erroring.**

This is the design's central property, and it dissolves most of what makes a single-owner topology
frightening. The failure question is usually "what happens to in-flight callers when the process
holding the only DB connection dies?" Here the answer is that it never holds the _only_ connection
— it holds the _fast_ one. A caller that cannot reach it does what it does today.

Concretely:

- **Hooks keep failing open.** That is already their contract (`ensureHookDomainBootstrap` returns
  a failure as a value rather than throwing, precisely so a hook never blocks the event it
  observes). The gateway adds one more way to reach the DB; it does not add a way to fail.
- **One attempt, then fall back.** No retry loop against a dead daemon: a hook budget measured in
  tens of milliseconds cannot absorb backoff. Retry belongs to the daemon's own supervision
  (ADR-014, and mt#3815's generalization to N daemons in PR #2953), not to the caller.
- **A restart costs a re-dial, not state.** The daemon holds no durable state of its own; Postgres
  is still the system of record. ADR-038 measured MCP clients re-initializing transparently in
  8–14ms after a session reap, which bounds the analogous cost here.

**What this deliberately gives up:** the gateway cannot enforce anything, because a caller can
always route around it. If a future requirement needs the owner to be authoritative — a local
single-writer invariant, an audit chokepoint — that is a different ADR, and it should say so
rather than quietly tightening this one.

## Question 3 — backpressure

**Decision: the owner holds an ordinary connection pool, and sheds load by refusing fast rather
than by queueing.**

Single-writer contention is not a v1 problem, and it is worth being precise about why: behind
hosted Postgres the owner holds a normal pool, so N concurrent callers are N pooled connections,
not a serialized queue. The single-writer ceiling only becomes real under PGlite (Question 5),
which this ADR does not authorize.

For v1: a bounded in-flight limit, and a request over that limit gets an immediate refusal, not a
queue slot. A caller that is refused falls back per Question 2 — which means shedding load
degrades to today's performance rather than to an error. Queueing would invert that: it converts a
fast local failure into a slow one, which is the worst outcome for a caller on a tens-of-ms
budget.

## Question 4 — the gateway design

**Decision: expose the domain operations callers actually need. Do not expose SQL.**

A generic SQL-over-HTTP endpoint would be simpler to build and is the wrong shape twice over. It
puts an arbitrary-query surface on loopback behind a static file token, and it routes around
ADR-002's persistence-provider abstraction — every consumer would then depend on the database
directly rather than on the domain, which is the coupling ADR-002 exists to prevent.

The surface is therefore derived from the enumerated consumers below, not designed in the
abstract. That enumeration is also this ADR's discharge of the contract-propagation obligation
mt#2430's 2026-08-13 gate recorded as deferred.

**Persistence-seam consumers (verified 2026-08-14 by grep, not inferred).** Fourteen non-test hook
modules reach persistence through `ensureHookDomainBootstrap` + `resolvePersistenceProviderOrError`:

`calibration-review-cadence-detector` · `constructed-identifier-batch-detector` ·
`duplicate-signature-scan` · `knowledge-acquisition-detector` · `negative-existence-claim-detector` ·
`post-merge-unasked-direction-scan` · `record-agent-dispatch` · `record-conversation-run-state` ·
`record-subagent-invocation` · `retrospective-trigger-scanner` · `stale-signal-sweep` ·
`stamp-pr-author-link` · `stamp-session-creator-link` · `standalone-dup-probe`

Plus the `scripts/verify-*` and `scripts/smoke-*` family, which reach the same seam and are the
natural first live-verification consumers.

These fall into two shapes — **stamp/record writes** (`record-*`, `stamp-*`) and **lookup reads**
(the detectors and scans). Both are small, both are latency-critical, and neither needs a
transaction spanning multiple calls. That is what makes a request-per-call gateway sufficient and
a session-oriented protocol unnecessary.

## Question 5 — PGlite behind the owner

**Decision: this ADR makes PGlite topologically possible and does not authorize it. It stays
gated at mt#434.**

The original motivation for a single owner was that PGlite is single-process: multiple OS
processes cannot open the same data directory, so PGlite was incompatible with today's
many-processes topology. A single owner removes that incompatibility — which is a statement about
topology, not about whether PGlite is a good idea.

Two things bound it, and both are quotations rather than readings:

**ADR-027** (Accepted, and this ADR **matches** it): _"If a zero-dependency embedded
local-Postgres option is ever wanted … the vehicle is PGlite (mt#434) … mt#434 remains
deferred/demand-gated; it is not authorized by this ADR."_

**The vendor's own docs**, read 2026-08-14 for `@electric-sql/pglite-socket` (Apache-2.0, v0.2.8):
_"Although PGlite is a single-connection database, it is possible to open and use multiple
simultaneous connections with pglite-server"_ — but _"Multiple concurrent connections are supported
through a **multiplexer** over the single conn, therefore not all cases might be covered,"_ and the
package is scoped to development rather than production.

Note what that does and does not mean for mt#2430's prior-art section, which speculated that
pglite-socket "could remove the strongest reason to build." It does not. Serving PGlite over a
socket **is** the single-owner topology — one process holds the directory and serves the rest.
pglite-socket is a candidate for what the owner uses underneath, not an alternative to having an
owner. Under PGlite, Question 3's pool becomes a genuine single-writer multiplexer and its
analysis must be redone.

## Question 6 — mesh and hosted convergence

**Decision: the owner is a local-only optimization. A remote owner is not the same problem and is
not designed here.**

Hosted Postgres already has an owner: Supavisor multiplexes connections, which is why hosted
services pay the handshake once per long-lived process rather than once per fire. The cost this
ADR removes is specific to a machine spawning many short-lived processes — the local development
topology.

What converges is the **domain API**, not the transport. Callers go through ADR-002's provider
abstraction either way, so which side of the seam holds the connection is a binding decision, not
an architectural one. That is enough convergence to keep the hosted and mesh directions open
without designing for them now.

**Confidence:** `inferred`. This asserts that no hosted consumer has the many-short-lived-processes
shape; the hosted deployment was not profiled for this ADR. If a hosted consumer turns out to
share it, that is a reason to revisit — not a reason to widen the design speculatively.

## Question 7 — coexistence

**Decision: opt-in, off by default, with direct-connect as the fallback on every path.**

There is no migration and no cutover. A machine with the daemon running and the gateway enabled
gets faster hooks; every other machine, and every CI runner, behaves exactly as it does today.
Because Question 2 requires the fallback on every path, "enabled" and "disabled" differ only in
latency — which is what makes this safe to ship one consumer at a time.

## Relationship to the accepted records

- **ADR-002 (persistence-provider architecture) — EXTEND.** The gateway is reached through the
  provider abstraction, not beside it. Question 4's refusal to expose SQL is what keeps this an
  extension rather than a bypass.
- **ADR-027 (Postgres-only persistence) — MATCH.** Postgres remains the only authorized backend;
  PGlite stays gated at mt#434, quoted verbatim in Question 5.
- **ADR-038 (local shared MCP daemon) — EXTEND.** Same process, same fixed port, same token, same
  discovery file. This adds a non-MCP consumer that ADR-038's discovery-file format was already
  written to serve, and Question 1 records why that consumer needs no shim.
- **ADR-014 (cockpit-daemon lifecycle) — considered, does not govern.** ask#7583 moved ownership
  off the cockpit daemon. Supervision of the MCP daemon is ADR-014's model as generalized by
  mt#3815 (PR #2953, open at time of writing), and this ADR consumes that rather than restating it.

## Consequences

**Good.** The per-fire handshake disappears for the hooks that opt in. Nothing can regress below
today's behavior, because today's behavior is the fallback. PGlite's topological blocker is
removed without committing to PGlite. The daemon gains a consumer that justifies its being
long-lived.

**Bad.** Two code paths per consumer — gateway and direct — which is more surface than one. The
`0600` token becomes a slightly more valuable local secret. A caller that silently falls back
every time looks identical to one that is working, so the gateway needs a counter that
distinguishes "used" from "fell back," or its own failure will be invisible in exactly the way
mt#3879's timeout was.

**Deferred.** The measured round-trip (Question 1), the in-flight limit's actual value (Question
3), and the PGlite evaluation (Question 5, mt#434).

## Follow-up subtasks

Filed against mt#2430 once this ADR is accepted, per its success criteria: the gateway endpoint on
the daemon; the client-side provider binding with fallback plus the used-vs-fell-back counter; and
conversion of the first hook consumer with a before/after measurement against the table in
`## Context`.
