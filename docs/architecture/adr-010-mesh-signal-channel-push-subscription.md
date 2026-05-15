# ADR-010: Mesh Signal Channel — Push/Subscription Architecture

## Status

Proposed

## Context

Minsky operates concurrent sessions, automated subagents, scheduled reapers,
and a cockpit-side rendering surface — each producing or consuming state
transitions that other participants need to react to. Today these reactions
happen by polling: the cockpit refreshes widgets on intervals; the reviewer
service sweeps for missed reviews; the orchestrate skill re-reads session
state before dispatching. Polling is correctness-preserving but expensive
relative to push: it scales with the number of pollers × the cost of one
pull, and latency is bounded below by the polling interval.

### The decisions to make

The mesh signal channel (parent: mt#773 mesh roadmap; investigation: mt#1001)
needs three concrete choices to unblock downstream consumers:

1. **Intra-host substrate** — what carries events between processes on the
   same machine (cockpit server, reviewer service, CLI session, MCP
   subagent)?
2. **External-surface transport** — what delivers events to surfaces outside
   the Minsky process tree (browser-based cockpit UI, future remote
   subscribers)?
3. **Subscription model** — how does a subscriber declare interest in a
   subset of events?

### What already exists

The substrate is partially in place. The attention-window primitive
(mt#1411 / mt#1489) emits `pg_notify` on dedicated channels today
(`minsky.attention_window_opened`, `minsky.attention_window_closed`) via
`createPostgresWindowNotifier` (`src/domain/ask/attention-windows/notify.ts`).
The MCP HTTP server already handles SSE GET streams for tool-call responses
(the `handleHttpGet` path in `src/mcp/server.ts`). The persistence layer exposes
`getRawSqlConnection()` on `SqlCapablePersistenceProvider` as the supported
path for raw-SQL operations including `pg_notify`. Identity is unified by
mt#1078's `agent_id` reverse-domain format (`{kind}:{scope}:{id}`).

What is missing is the LISTEN-side wiring (subscribers), an SSE-broker
shape for the external surface, an event taxonomy beyond the two attention
channels, and a schema convention that new event classes can join without
re-architecting the substrate.

### Alternatives considered

- **WebSocket broker.** Adds a second store and a connection-state ownership
  problem. Postgres LISTEN/NOTIFY (default per the `§Datastores` policy in
  `decision-defaults.mdc`) covers the same workload without introducing a new
  infrastructure layer.
- **AG-UI protocol** (mt#697 evaluation, DONE). Survey concluded AG-UI is
  agent-to-UI 1:1 streaming; the mesh needs pub/sub across concurrent
  sessions — different abstraction. AG-UI is adopted for Layer 2 HITL
  interrupts and the Locus cockpit view layer, not for mesh signals.
- **Matrix homeserver** (mt#1454, research-only sibling). Adopting Matrix as
  a mesh substrate constitutes a second store and crosses the §Datastores
  policy bar; mt#1454 makes the contrary case if one exists. Until that
  verdict, this ADR proceeds with the §Datastores default. If mt#1454 flips
  the substrate choice for any subset of mesh signals, a superseding ADR
  replaces this one for that subset.
- **Streamable HTTP MCP** (mt#703, CLOSED). The MCP transport already
  underpins agent ↔ Minsky calls; reusing it for mesh signal subscription
  is possible but couples mesh delivery to MCP session lifetime. SSE on a
  separate endpoint is independent of MCP session state.

### Substrate constraint: Supavisor transaction pooler

Minsky's production Postgres connection is Supavisor's transaction pooler
(port 6543). The pooler is session-mode-incompatible by design — no
session-scoped state: no prepared statements, no advisory locks, **no
LISTEN**. `pg_notify` (emit side) works fine through the transaction pooler
because it is fire-and-forget within a single statement. LISTEN (subscribe
side) requires session-scoped state and therefore a different connection.

The resolution: subscribers hold a dedicated direct connection to Postgres
(bypassing the pooler) for LISTEN. This adds one direct connection per
subscriber process, not per subscription — channels multiplex on a single
connection. The pool-budget calculus is updated accordingly: each subscriber
adds 1 to Minsky's direct-connection count, separate from the pooled
connections it uses for normal queries.

## Decision

**We adopt Postgres LISTEN/NOTIFY as the intra-host substrate and Server-Sent
Events as the external-surface transport for the mesh signal channel.**

The mechanism, in three parts:

### 1. Intra-host: Postgres LISTEN/NOTIFY

- **Emit side** continues through the pooled connection via the pattern:

  ```ts
  const sql = await provider.getRawSqlConnection();
  await sql.unsafe(`SELECT pg_notify($1, $2)`, [channel, payloadJson]);
  ```

  The existing `createPostgresWindowNotifier` is the canonical pattern; new
  event classes ship their own thin notifier following the same shape
  (injectable interface + Postgres implementation + no-op + recording
  variants for tests).

- **Subscribe side** uses a dedicated direct Postgres connection per
  subscriber process. A library helper (filed as a follow-up below) manages
  connection lifecycle, automatic reconnect, and channel multiplexing.
  Subscribers register typed listeners per channel.
- **Channel naming**: `minsky.<event-class>.<event-type>` (e.g.
  `minsky.session.started`, `minsky.task.status_changed`,
  `minsky.attention.window_opened`). Existing channels
  (`minsky.attention_window_opened`, `minsky.attention_window_closed`) are
  grandfathered under their current names; new channels follow the dotted
  hierarchical convention so consumer-side topic filtering can use prefix
  matching.

### 2. External surface: Server-Sent Events (SSE)

The cockpit web client and any future browser-based surfaces consume events
via SSE from the cockpit's HTTP server. The cockpit server is the SSE broker:
it holds the LISTEN connection (as a single subscriber), receives Postgres
NOTIFY payloads, and forwards them to connected SSE clients. Each SSE client
declares its topic filter in the connection URL
(`/api/events?topics=session.*,attention.*`).

Why SSE over WebSockets for external delivery: one-way (server → client) push
matches the use case; SSE multiplexes over HTTP/2; reconnect semantics are
standardised in the EventSource API; the cockpit is already an HTTP server,
not a WebSocket server.

### 3. Subscription model: topic-based, identity-tagged payloads

- Subscription is by channel/topic, not by query or predicate. Subscribers
  filter at the consumer side after delivery. This keeps the substrate
  semantics matched to Postgres NOTIFY's wire shape.
- Every event payload carries `agentId` (per mt#1078) and `at` (ISO-8601)
  at minimum; event-class-specific fields layer on top.
- Four canonical event-type payloads are defined as the initial taxonomy:

```typescript
// Channel: minsky.session.started
interface SessionStartedPayload {
  agentId: AgentId; // {kind}:{scope}:{id}, per mt#1078
  sessionId: string;
  parentSessionId?: string; // when subagent
  capabilities?: string[]; // optional tool-surface enumeration
  at: string; // ISO-8601
}

// Channel: minsky.session.scope_changed
interface SessionScopeChangedPayload {
  agentId: AgentId;
  sessionId: string;
  scope: {
    files?: string[];
    symbols?: string[];
  };
  changeType: "added" | "removed" | "replaced";
  at: string;
}

// Channel: minsky.task.status_changed
interface TaskStatusChangedPayload {
  taskId: string;
  from: TaskStatus; // TODO | PLANNING | READY | IN-PROGRESS | IN-REVIEW | DONE | BLOCKED | CLOSED
  to: TaskStatus;
  agentId: AgentId; // who advanced the task
  at: string;
}

// Channel: minsky.task.blocking
interface TaskBlockingPayload {
  sessionId: string;
  taskId: string;
  reason: string;
  askId?: string; // when blocking surfaces as an Ask (ADR-008)
  at: string;
}
```

Event-class definitions live alongside their emitting subsystem
(`src/domain/<subsystem>/events.ts`). A registry pattern lets the cockpit
SSE broker know the type of each channel's payload for safe deserialization.

## Consequences

### Easier

- Downstream consumers (mt#1148 SSE transport Stage 2, mt#1147 deferred
  items, future mesh subscribers) can now ship against a named substrate
  with concrete event payloads. The previously-deferred cockpit items
  (Postgres NOTIFY LISTEN wiring, Defer button, non-null `activeWindowKey`)
  have a clear implementation path.
- New event classes follow the existing `createPostgresWindowNotifier`
  pattern; adding a new channel is one file (`events.ts` + emit-site wiring)
  rather than a substrate change.
- Identity-tagged payloads make event observability trivial: every event
  carries `agentId`, so the same payload shape feeds observability tools
  and live rendering surfaces.

### Harder / committed

- Subscribers must own a dedicated direct connection to Postgres for LISTEN.
  The pool-budget memory needs updating: each subscriber process adds one
  direct connection (separate from pooled connections) to Minsky's
  connection count.
- Cross-host coordination is deferred. Two Minsky processes on different
  machines need a different substrate (the same Postgres works in principle
  if both can reach it; otherwise an explicit bridge). v1 ships
  intra-host-only; cross-host is a deferred follow-up.
- Event class definitions become contract surface. Adding fields to a
  payload is contract evolution; removing or renaming fields requires the
  consumer-enumeration discipline of `contract_propagation` (gate (h) of
  `/plan-task`).

### Follow-up tasks

Filed as children of mt#1001 on ADR acceptance:

1. **LISTEN-side subscriber library** — `PostgresChannelListener` with
   dedicated direct connection, automatic reconnect, channel multiplexing,
   typed listener registration. Foundational for every other follow-up.
2. **Cockpit SSE broker** — cockpit server holds the LISTEN connection,
   forwards Postgres NOTIFY payloads to connected SSE clients with topic
   filtering. Closes mt#1147's deferred-items gate and unblocks mt#1148
   Stage 2.
3. **Event taxonomy expansion** — add the four canonical channels in this
   ADR (`minsky.session.started`, `minsky.session.scope_changed`,
   `minsky.task.status_changed`, `minsky.task.blocking`) as concrete
   notifier modules and emit-site wirings.
4. **Cross-host transport investigation** — deferred research; opens when
   multi-machine coordination becomes a need.

### Provisional-then-amend with mt#1454

mt#1454 (Matrix-rooms substrate evaluation) is the contrary-case
investigation per the §Datastores policy bar. If it concludes Matrix should
replace Postgres LISTEN/NOTIFY for any subset of mesh signals, a superseding
ADR replaces this one for that subset, citing this ADR's number under
`Supersedes ADR-010`. This ADR does not gate on mt#1454; the default
substrate ships immediately so downstream consumers unblock.

## Cross-references

- Related ADRs: [ADR-002](adr-002-persistence-provider-architecture.md)
  (persistence-provider abstraction — establishes `getRawSqlConnection`);
  [ADR-008](adr-008-attention-allocation-subsystem.md) (attention-allocation
  subsystem — defines Ask-bound events that flow through this substrate);
  [ADR-009](adr-009-in-band-review-semantics.md) (in-band review semantics —
  sibling decision producing structural review events that may join this
  channel).
- Related tasks: mt#1001 (this ADR's task); mt#1148 (cockpit push transport,
  Stage 2 consumer); mt#1147 (Attention widget, deferred-items consumer);
  mt#1411 / mt#1489 (existing NOTIFY emit infrastructure); mt#1454 (Matrix
  substrate evaluation, contrary-case sibling); mt#1078 (agent identity);
  mt#773 (mesh roadmap, parent).
- Memory entries: `df19d9e1-f628-4a0f-a199-d6ae2502afb8`
  (Postgres-via-Supabase default datastore — policy precedent);
  `c66505b6-680c-4a41-8ef0-c71ec2a24a07` (reconciliation over replication —
  adjacent principle); `fa3bcdaa-15b5-4286-b073-b3460cbcbb03` (Mesh
  observability infrastructure — substrate of session liveness this builds
  on); `63fbc195-fc1f-4e0e-be41-f109c3b169de` (Supabase Remote Database —
  pool-budget context for the subscriber-direct-connection constraint).
- mt#697 input embedded in mt#1001 spec's "Input from mt#697" section.
- Mesh RFC (Notion): `33a937f0-3cb4-814f-8603-ff6faa52ec6b`.
