# Background polling and wake-signal mechanisms

> **Owning task:** mt#1519 — catalog the mechanisms an in-conversation agent can use to wait
> on or learn about async events, identify the wake-signal transport gap, and recommend the
> short-term bridge until mt#1001 (mesh push) and mt#1144 (cockpit) land.
>
> **Audience:** any agent (or human reading on its behalf) deciding how to resume work after
> an external event — PR review landed, Ask responded, sweeper output ready, CI completed,
> sibling PR merged.

The question this doc answers: **where does an in-conversation agent learn about things
that happen between its own tool calls?** "I'll wait for the user to ping me" is the
failure mode this catalog exists to prevent.

---

## 1. Transport-class taxonomy

Every mechanism below falls into one of three classes. Picking the right _class_ first is
more important than picking the right _mechanism_; classes differ on who initiates, where
delivery lands, and whether the agent's conversation context receives the signal at all.

### Class A — Push (server → harness → agent context)

The originating event triggers a transport layer that pushes a signal **into the agent's
conversation context**. The agent does not initiate; it receives. This is the only class
that closes the gap completely — the agent learns about the event without having to call
any tool.

Push transports require harness support: the harness must be willing to accept and render
an out-of-band signal as a system-reminder, tool result, or equivalent context injection.
At Minsky's current state, this class is mostly aspirational — Claude Code's `/mcp` panel
may render `notifications/message` (unconfirmed; see mt#1315) but does not surface them
into the model's context.

### Class B — Pull-on-tool-call (middleware enrichment on tool boundaries)

When the agent calls _any_ MCP tool, middleware on the dispatch path enriches the response
with relevant out-of-band signals — pending wakes, fresh memory, attention notifications —
before the tool result is returned to the agent. The agent sees the signal _inside_ the
next tool result it would have received anyway; no new tool call required.

This class is **the natural fit for an in-conversation consumer** when push isn't
available. The signal is delivered piggyback on tool calls the agent is going to make
anyway, with bounded latency: at most one tool-call interval. mt#1588 shipped the seam
(`enrichToolResponse` in `src/mcp/middleware/memory-enrichment.ts`) — currently used for
memory enrichment, but extensible to wake signals with a small additional sink.

### Class C — Agent-driven poll (agent calls a query tool, possibly self-paced)

The agent itself calls a query tool (`asks_list`, `pr_watch_list`, GitHub read tools)
and inspects the returned state. Self-pacing wraps the call in `ScheduleWakeup`, `/loop`,
`Monitor`, or `CronCreate` so the agent doesn't have to think between calls.

This class works today without infrastructure changes, but it's costly: every poll burns
context, every poll is a model invocation, and the latency floor is the polling interval.
It is the right shape when you're _already_ idle and willing to pay the cost; it is the
wrong shape as the steady-state mechanism for a busy agent.

---

## 2. Mechanism catalog

Each mechanism is recorded as: **class**, **shape**, **fit profile**, **latency**,
**example**, **production status**.

### 2.1 `notifications/message` — server-pushed MCP log notifications

- **Class:** A (push)
- **Shape:** MCP server emits `notifications/message` over the active transport (stdio /
  HTTP). The MCP client (Claude Code, etc.) decides whether to render it.
- **Fit:** would be the right shape for "server has something to tell the agent" if Claude
  Code rendered it into the model's context. mt#1315 spike concluded `/mcp` UI rendering
  is **unobserved from agent-side**; recommendation locks in `exit-plus-message` for
  staleness only.
- **Latency:** transport-bounded (sub-second).
- **Example:** `docs/mcp-signaling-spike-findings.md` Recommendation §.
- **Production status:** **inert for in-context delivery.** Fires server-to-client; UI
  render path unconfirmed, no path into the model context. Track mt#1144 (cockpit) and
  any future Claude Code roadmap for changes.

### 2.2 mt#1001 mesh signal push — long-term subscriber

- **Class:** A (push)
- **Shape:** LISTEN/NOTIFY on Postgres + SSE delivery to subscribers. Cross-session.
- **Fit:** the canonical long-term answer for `coordination.notify` Asks and for cross-session
  attention signals. Should subsume Class A coverage when it lands.
- **Latency:** target sub-second.
- **Example:** none yet.
- **Production status:** **TODO** (mt#1001). Spec exists; no implementation. Until it
  ships, Class A coverage is effectively zero for in-context delivery.

### 2.3 `OperatorNotify` from `mcp__minsky__pr_watch_run`

- **Class:** A (push) — but pushed to **operator desktop**, NOT agent context.
- **Shape:** post-mt#1618, the production `runWatcher` is invoked on a periodic scheduler
  with a real `GithubPrClient` (`src/adapters/shared/commands/pr-watch.ts:283-284`). On a
  matching event (`review-posted`, `merged`, `check-status-changed`), it fires
  `operatorNotify.bell()` + `operatorNotify.notify(title, body)`
  (`src/domain/pr-watch/watcher.ts:255-256`).
- **Fit:** signals to the _human operator_ watching the laptop. Useful for "go look at
  this." Does NOT close the in-conversation gap.
- **Latency:** ≤ 1 polling interval (mt#1618 default 30–60s for active windows).
- **Example:** register a watch via `mcp__minsky__pr_watch_create` with `event:
"review-posted"`. The watcher fires terminal-bell + native OS notification when matched.
- **Production status:** **wired post-mt#1618** (commit `cd3ecbced`) for desktop delivery.
  **Residual gap for agent context:** the delivery target is the laptop, not the agent's
  conversation. Closing that gap is exactly the work `docs/background-polling.md §4` names
  as the wake-signal transport gap.

### 2.4 `LoggingWakeSignalSink` — operator-readable stdout `ask.wake` events

- **Class:** A (push) — but pushed to **operator stdout**, NOT agent context.
- **Shape:** `src/domain/ask/wake-on-respond.ts`. When a `quality.review` Ask transitions
  `suspended → responded` (via the reconciler at `src/domain/ask/reconciler.ts:316`), the
  default sink writes `ask.wake <JSON-payload>` via `log.cli`. Operators tail and grep the
  stream.
- **Fit:** operator audit + diagnostics; downstream input for any consumer that can read
  the line.
- **Latency:** transport-bounded.
- **Example:** `grep '^ask\.wake' <log>` shows wakes the reconciler emitted.
- **Production status:** **wired (mt#1481).** Not in-agent-context; gap is on the consumer
  side, not the producer. Extension point: implementing a second `WakeSignalSink` that
  _also_ persists wakes to a queryable store closes the consumer-side gap (see §5 below).

### 2.5 mt#1588 `enrichToolResponse` middleware on `CallToolRequestSchema`

- **Class:** B (pull-on-tool-call)
- **Shape:** `src/mcp/middleware/memory-enrichment.ts` and the wiring at
  `src/mcp/server.ts:705-714`. The MCP `CallToolRequestSchema` handler invokes
  `enrichToolResponse(name, args, memoryService)` after every allowlisted tool call,
  appending a `{type:"text"}` content block with relevant memory results.
- **Fit:** **the natural seam for in-conversation wake delivery.** Already handles the
  "augment any tool response with out-of-band context" pattern; extending to wake events
  is a sibling implementation of the same shape (different sink, different store).
- **Latency:** ≤ 1 tool-call interval (the agent learns about the wake at its next tool
  call). For an active agent, this is sub-second to seconds.
- **Example (memory; existing):** any allowlisted tool call returns `{content: [tool-result,
memory-enrichment-block]}`.
- **Example (wakes; proposed):** `{content: [tool-result, wake-events-block]}` when the
  calling session has pending wake events queued.
- **Production status:** **wired for memory enrichment (mt#1588).** Wake-event extension
  is the §5 short-term bridge proposal below.

### 2.6 `UserPromptSubmit` hook — `mcp__minsky__memory_search` results injection

- **Class:** B (pull-on-tool-call) — variant: pull-on-user-prompt
- **Shape:** `.claude/hooks/memory-search.ts`. Per CLAUDE.md `§Memory Usage — Bridge
mechanism (Claude Code only)`, a `UserPromptSubmit` hook invokes `memory_search` on
  non-trivial prompts and injects the top-K results into the model's context.
- **Fit:** Claude Code-specific bridge; mt#1588's middleware is the harness-agnostic
  successor. Not a general wake-signal transport.
- **Latency:** ≤ 1 user-prompt round-trip.
- **Production status:** **wired (Claude Code only)**, retiring when mt#1588 covers all
  MCP tool calls.

### 2.7 `ScheduleWakeup` — in-conversation self-pacing

- **Class:** C (agent-driven poll)
- **Shape:** Claude Code deferred tool. `ScheduleWakeup({delaySeconds, prompt, reason})`
  schedules a self-resume of the current `/loop` invocation. Used by `/loop` dynamic mode.
- **Fit:** "I'm idle waiting for X; come back in N seconds." Bounded by cache-window
  economics (≤ 270s keeps cache warm; 1200–1800s for genuinely-idle waits).
- **Latency:** the chosen `delaySeconds`.
- **Example:** waiting for a long build to finish; check back every 270s.
- **Production status:** **available (Claude Code only).** Harness-specific.

### 2.8 `CronCreate` / `/schedule` — cross-conversation cron routines

- **Class:** C (agent-driven poll, persisted)
- **Shape:** `CronCreate` registers a routine; `/schedule` skill manages them. Routines
  fire on a cron schedule and dispatch a fresh agent context.
- **Fit:** "every morning, do X." Not for tight-loop polling — overhead is high.
- **Latency:** cron-precision.
- **Production status:** **available (Claude Code).**

### 2.9 `/loop` skill — recurring task driver

- **Class:** C (agent-driven poll)
- **Shape:** `.claude/skills/loop/SKILL.md`. Wraps a prompt or slash command in a recurring
  loop. Two modes: fixed interval (`/loop 5m /foo`) and dynamic (the model paces via
  `ScheduleWakeup`).
- **Fit:** "keep doing X every N." Caps polling cost at the chosen interval.
- **Latency:** the chosen interval (or model-chosen for dynamic).
- **Production status:** **available (Claude Code).**

### 2.10 `Monitor` — stream tail / wait-for-condition

- **Class:** C (agent-driven poll, but blocking with line-by-line notification)
- **Shape:** Claude Code deferred tool. Monitors a background process; each stdout line is
  a notification. Supports until-loops (`until <check>; do sleep 2; done`) for "wait until
  X."
- **Fit:** "watch this process / file / log stream until something happens." Right shape
  for tailing the `ask.wake` stdout from `LoggingWakeSignalSink`.
- **Latency:** sub-second once a line is written.
- **Production status:** **available (Claude Code).**

### 2.11 `mcp__minsky__session_pr_wait-for-review` — blocking review wait

- **Class:** C (agent-driven poll, server-side)
- **Shape:** MCP tool that polls the forge until a review appears (or timeout). Default
  filters new reviews only; `reviewer: "minsky-reviewer[bot]"` filters identity.
- **Fit:** **today's correct answer for "babysit a PR through reviewer-bot iteration."**
  See worked example §6.
- **Latency:** typical 30s–2min after push; bounded by the call's `timeoutSeconds`
  (1–1800).
- **Production status:** **available (DONE).** Cited by `/implement-task §9` as the
  default mechanism.

### 2.12 `mcp__minsky__pr_watch_create` + scheduler — registered PR-state watch

- **Class:** B (pull-on-tool-call) post-mt#1725 — agent-context delivery via `WakeSignalSink`. Also fires Class A (laptop) notifications via `OperatorNotify` for operators who want desktop alerts. See §2.3 for the operator-side path.
- **Shape:** post-mt#1618, `pr_watch_create` registers a DB row (now including the registering agent's `parentSessionId` captured at call time per mt#1725); the scheduler invokes `pr_watch_run` periodically against the production `GithubPrClient`. On match, the watcher fires both `OperatorNotify` (desktop bell + native notification) AND emits a `pr.watch`-kind row to `wake_pending` keyed on `parentSessionId`. The `enrichWakeResponse` middleware drains the row on the registering agent's next allowlisted MCP tool call (per the §5 bridge's pull-on-tool-call seam).
- **Fit:** registered PR-state watch outliving the conversation. Right shape when the watch survives across session restarts AND for in-conversation delivery to the registering agent. Coverage profile inherits mt#1661 v0's addressing constraints — wake delivers when the next MCP call carries a session arg (`session`/`sessionId`/`task`/`taskId`) that resolves to the registering session; otherwise telemetered as `wake.enrichment.no_session_id`.
- **Latency:** ≤ 1 polling interval for the predicate match + ≤ 1 tool-call interval for delivery to the registering agent.
- **Production status:** **wired post-mt#1725** for both desktop notify (mt#1618) and agent-context delivery (mt#1725). mt#1506 (PLANNING — InterfaceBinding model) is the long-term retirement path for v0 addressing limitations.

### 2.13 `mcp__minsky__asks_list` — agent-driven query against Asks

- **Class:** C (agent-driven poll)
- **Shape:** MCP tool. Returns Asks filtered by state, kind, parent session, etc. The
  in-conversation agent calls it periodically to detect Asks that have transitioned to
  `responded`.
- **Fit:** universal — works for any consumer with Ask access. Cost: every poll is a tool
  call (model + transport overhead).
- **Latency:** the chosen polling interval.
- **Example:** wrap in `/loop 30s` while waiting on a `quality.review` Ask response.
- **Production status:** **available.** The dog-food consumer for the Ask system; works
  today without infrastructure changes.

### 2.14 `RemoteTrigger` / `PushNotification`

- **Class:** A (push) — Claude Code-internal primitives.
- **Shape:** Claude Code deferred tools. Not yet exercised in Minsky workflows; mentioned
  in deferred-tool list.
- **Fit:** unknown without spike. Likely useful for cross-conversation wake-up if the
  harness exposes them.
- **Production status:** **untested in Minsky.** Investigate as part of mt#1593's skill
  step or as a dedicated spike.

---

## 3. Decision matrix

For each event, the _right class_ first, then the _concrete mechanism_ within it.

| Event                            | Class today | Mechanism today                                      | Class with bridge | Mechanism with bridge |
| -------------------------------- | ----------- | ---------------------------------------------------- | ----------------- | --------------------- |
| Reviewer-bot review posted on PR | C           | `session_pr_wait-for-review`                         | B                 | mt#1588 + wake sink   |
| `quality.review` Ask responded   | C           | `/loop` + `asks_list` poll                           | B                 | mt#1588 + wake sink   |
| Sibling PR merged on `main`      | C / B       | `git_log` poll OR `pr_watch_create` (B post-mt#1725) | A (mt#1001)       | mesh push subscriber  |
| CI completed on a PR             | C           | `pull_request_read get_check_runs` poll              | A (mt#1001)       | mesh push subscriber  |
| Long subprocess finished         | C           | `Monitor` (line-by-line)                             | (no change)       | (no change)           |
| Sweeper output ready             | C           | `asks_list` poll                                     | B                 | mt#1588 + wake sink   |
| Cron-fired routine               | C           | `CronCreate` / `/schedule`                           | (no change)       | (no change)           |
| MCP server became stale          | A (limited) | `notifications/message` + exit (mt#1315)             | (no change)       | (no change)           |

**Reading the table:** the "today" columns describe what works as of 2026-05-08. The
"with bridge" columns describe what would work after the §5 short-term bridge ships and
the §4 wake-signal transport gap closes. The bridge primarily upgrades Ask-mediated
events from C (poll) to B (pull-on-tool-call).

---

## 4. Wake-signal transport gap

This section names the gap concretely so an implementer can target it.

### 4.1 What `LoggingWakeSignalSink` solves

- Captures every `quality.review.responded` transition with the seven canonical fields
  (`askId`, `parentSessionId`, `parentTaskId`, `reviewBody`, `reviewState`, `reviewAuthor`,
  `prNumber`) — see `src/domain/ask/wake-on-respond.ts:28-43`.
- Emits an `ask.wake <JSON>` line on the program logger so it appears regardless of
  log mode.
- Provides a structural extension point: the `WakeSignalSink` interface
  (`wake-on-respond.ts:53-60`) is the DI seam for additional sinks.

### 4.2 What `LoggingWakeSignalSink` does NOT solve

- **Delivery target is operator stdout, not agent context.** Operators tail and grep the
  stream; the in-conversation agent that filed the originating Ask has no path to the
  line. The signal exists in the operator's terminal, not in the model's context.
- **No queryable store.** The line is the only artifact. To learn about a wake after the
  fact, an agent must replay logs, which is brittle.
- **No durable replay.** If the line scrolls past or the operator restarts the terminal,
  the signal is gone.

### 4.3 Post-mt#1725 closure of the pr_watch gap (historical)

- mt#1618 closed the _production wiring_ gap (real `GithubPrClient`, scheduled `pr_watch_run`). On a match, `operatorNotify.bell() + operatorNotify.notify(...)` fires reliably to the operator's laptop.
- **The remaining agent-context delivery gap was identical in shape to §4.2 above** until mt#1725: the only delivery target was the operator's laptop (terminal bell + native OS notification), not the agent's conversation. The agent that registered the watch had no path to the firing.
- **mt#1725 closed this gap** via WakeSignalSink integration. `pr_watch_create` now captures `parentSessionId` at registration; the watcher emits a `pr.watch`-kind wake-signal row to `wake_pending` alongside the existing `OperatorNotify` call; `enrichWakeResponse` drains it on the registering agent's next allowlisted MCP tool call. This is the same Class B (pull-on-tool-call) pattern §5's bridge established for Ask-mediated wakes — `pr_watch` matches now ride the same delivery infrastructure.

### 4.4 Which class closes the gap

- **Push (Class A)** would close it cleanly — but mt#1001 is TODO and `notifications/message`
  has no in-context render path today.
- **Pull-on-tool-call (Class B)** closes it on the agent side without harness changes:
  the agent learns about the wake at its next tool call, bounded latency, no model
  invocations between events. mt#1588's `enrichToolResponse` is the existing seam.
- **Agent-driven poll (Class C)** closes it but at a per-poll cost; works today but is the
  wrong steady-state answer for an active agent.

The structural recommendation: **extend mt#1588 to inject pending wakes**. See §5.

---

## 5. Short-term bridge spec

The smallest feasible primitive that closes the in-conversation wake-signal gap pre-mt#1001.

> **Status (2026-05-08):** v0 shipped via mt#1661. Schema, sinks, middleware, and
> composition wiring are live; see §5.6 for as-built notes and where the
> implementation diverged from this spec. v0 deliberately covers only the
> unambiguous addressing case (caller args carry `session`/`sessionId`/`task`/`taskId`)
> and emits a `wake.enrichment.no_session_id` telemetry counter for the cases it
> can't deliver — that counter is mt#1506's design input.
>
> **Retirement:** when mt#1506 (`InterfaceBinding` model) is integrated with
> `WakeSignalSink`, OR when mt#1001 (mesh push) supersedes the persistent table.

### 5.1 Mechanism

A second `WakeSignalSink` implementation (`PersistentWakeSignalSink`, working name)
persists wake events to a `wake_pending` table keyed by `parentSessionId`. The mt#1588
middleware (`enrichToolResponse`) is extended to drain wakes for the calling session at
every allowlisted tool call and inject them as a content block into the response.

### 5.2 Data flow

```
quality.review reconciler (src/domain/ask/reconciler.ts)
  → respondAsk() succeeds (suspended → responded)
  → dispatchWake(sink, args)
    → sink.emit(payload)            ← BOTH SINKS FIRE
      ├─ LoggingWakeSignalSink          (existing — operator stdout)
      └─ PersistentWakeSignalSink       (NEW — wake_pending table)

Later, when ANY agent calls an allowlisted MCP tool:
  CallToolRequestSchema handler (src/mcp/server.ts:652)
    → tool.handler(args) returns
    → enrichToolResponse(name, args, memoryService, wakeService)   ← EXTENDED
      ├─ memory enrichment block (existing)
      └─ wake events block        (NEW — drains wake_pending for caller session)
    → returned to agent in tool response

Agent sees the wake in the next tool result it would have received anyway.
```

### 5.3 Smallest-feasible primitive

**Schema (one new table, drizzle migration):**

```sql
CREATE TABLE wake_pending (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  parent_task_id TEXT,
  ask_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,            -- full WakeSignalPayload
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  drained_at TIMESTAMPTZ,                 -- nullable; set when delivered to agent
  drained_for_tool TEXT                   -- which tool call drained it
);
CREATE INDEX wake_pending_undelivered
  ON wake_pending (parent_session_id) WHERE drained_at IS NULL;
```

**Domain seam:**

- `src/domain/ask/wake-on-respond.ts` — add `PersistentWakeSignalSink` implementing
  `WakeSignalSink`, writing one row per emit.
- `src/mcp/middleware/wake-enrichment.ts` (new) — sibling to `memory-enrichment.ts`,
  exports `enrichWakeResponse(toolName, args, wakeService)`. Reads `parentSessionId` from
  call context (or args), drains undelivered rows in a transaction, returns one
  `{type:"text"}` block.
- `src/mcp/server.ts` — chain both enrichments at the existing seam (line 705 area).
- Composition root — register both sinks in the reconciler dependency graph.

**Allowlist:**

The wake-enrichment middleware uses the _same_ allowlist as memory-enrichment, OR a
broader one if wakes need delivery on a wider set of tool calls. Decision deferred to the
implementation task; default is "match memory-enrichment's allowlist" to keep blast
radius narrow.

### 5.4 Failure modes

- **Caller session unknown** — middleware skips silently. Wakes remain in `wake_pending`
  with `drained_at = NULL`; next call from the right session drains them.
- **DB unavailable** — middleware logs and skips (per the existing `enrichToolResponse`
  pattern of "enrichment must never break the tool call"). Wakes remain in `wake_pending`
  if the write succeeded; the read failure is transient.
- **Duplicate delivery** — the `drained_at` column prevents re-delivery on subsequent
  calls. If the agent loses context after seeing the wake, that's a different layer's
  problem (the wake was delivered).

### 5.5 What this does NOT include (out of scope for the bridge)

- mt#1001 mesh push (separate task; this is the pre-mt#1001 bridge).
- mt#1144 cockpit shell (separate task; this is in-context delivery, not UI).
- Push to non-MCP transports (e.g., AG-UI clients) — the bridge is MCP-only.

### 5.6 As-built notes (mt#1661 v0, 2026-05-08)

The shipped implementation diverges from §5.3's pre-implementation spec in three
non-substantive ways:

- **No `parent_task_id` column** in `wake_pending`. Removed during implementation
  because the full `WakeSignalPayload` (which includes `parentTaskId`) is stored as
  jsonb in `payload_json`; a separate column would duplicate it without enabling any
  query the producer/consumer needs in v0. Consumers that need to filter by task
  read the JSON.
- **Composition via `CompositeWakeSignalSink`** rather than amending `reconcile()`'s
  signature to take `wakeSinks: WakeSignalSink[]`. The composite class wraps both
  sinks and presents the existing single-sink contract. Smallest blast radius;
  reconciler signature unchanged.
- **Telemetry seam** — every `enrichWakeResponse` call emits one of three structured
  log events: `wake.enrichment.delivered` (with count), `wake.enrichment.no_session_id`
  (with tool name), or no event (silent no-op when session resolves but no pending
  wakes). `no_session_id` is the v0-inadequacy signal feeding mt#1506.

The session-resolver in v0 maps `args.session`/`args.sessionId` directly and
`args.task`/`args.taskId` via the existing `sessionProvider.getSessionByTaskId`
primitive. Tools without any of these args are out of v0's eligibility profile by
design — that's the case mt#1506's `InterfaceBinding` model needs to handle.

---

## 6. Worked example: babysit a PR through reviewer-bot iteration

**Scenario:** I just pushed PR #999. I want to know when `minsky-reviewer[bot]` posts a
review so I can address findings.

### 6.1 Today's pattern (no infrastructure changes)

Use `mcp__minsky__session_pr_wait-for-review`. This is the canonical answer cited by
`/implement-task §9`.

```
mcp__minsky__session_pr_wait-for-review({
  task: "mt#999",
  reviewer: "minsky-reviewer[bot]",
  timeoutSeconds: 1200,
  intervalSeconds: 15
})
```

The tool blocks server-side until a matching review appears or the timeout elapses.
Returns the review payload; the agent unblocks with full context. **This is Class C
(agent-driven poll) but server-side, so the agent doesn't burn context per poll.**

If the bot has already posted on this HEAD before the call, the default `since: <call-time>`
filter ignores the existing review. Fetch existing reviews via `session_pr_get` or
`pull_request_read get_reviews` first.

### 6.2 Bridged pattern (post-§5 implementation)

The same scenario, but for an Ask-mediated review (`quality.review` Ask filed by the
implementer, responded by the reviewer-bot via `asks_respond`). Today this requires
`/loop` + `asks_list` poll. After the §5 bridge:

1. Implementer files `quality.review` Ask (suspends conversation context).
2. Reviewer-bot calls `mcp__minsky__asks_respond` when the review is ready.
3. Reconciler transitions Ask `suspended → responded`, calls `dispatchWake`.
4. **Both** sinks fire: `LoggingWakeSignalSink` (operator stdout) AND `PersistentWakeSignalSink`
   (writes row to `wake_pending` keyed by `parentSessionId`).
5. Implementer agent makes its next MCP tool call (any allowlisted tool — `tasks_get`,
   `git_log`, anything).
6. `enrichToolResponse` chain runs:
   - memory-enrichment block appended (existing)
   - **wake-enrichment block appended (new)** — drains undelivered wakes for the calling
     session, returns `[wake-event-1, wake-event-2, ...]` as JSON in a `{type:"text"}` block.
7. Implementer agent sees the wake in the tool response. Latency = next tool call.

**Class transition:** C (poll) → B (pull-on-tool-call). Cost transition: per-poll model
invocation → zero (signal piggybacks on tool calls already happening).

### 6.3 What about `pr_watch` for in-conversation delivery?

Post-mt#1725: **yes, `pr_watch_create` is a viable in-conversation mechanism.** Use it when you want fire-and-forget notification that arrives on your next MCP tool call rather than a blocking `session_pr_wait-for-review` wait. The watch persists across short context boundaries; the wake-events block is drained when you next call any allowlisted tool with the registering session's arg.

```
mcp__minsky__pr_watch_create({
  owner: "edobry",
  repo: "minsky",
  number: 999,
  event: "review-posted",
  // session arg captured automatically from MCP call context
})
// ... do other work ...
// On any allowlisted tool call (e.g., tasks.status.get, session.pr.get):
//   { content: [tool-result, wake-events-block] }
// The wake-events block surfaces the matched watch firing.
```

For PR-review-class waits where the agent intends to immediately act on the review, both `session_pr_wait-for-review` (blocking, sub-minute latency) and `pr_watch_create` + arbitrary follow-up tool call are valid. Use the wait tool when the agent will block; use the watch when the agent intends to do other work between PR-creation and review-arrival.

Operator-side delivery (terminal bell + native OS notification via `OperatorNotify` — see §2.3) continues to fire alongside the agent-context delivery; both paths are wired.

---

## 7. Cross-references and follow-ups

### 7.1 Tracked tasks

- **mt#1001** — mesh signal push (TODO). Long-term Class A subscriber. Should expose a
  shape compatible with `WakeSignalPayload` so the §5 bridge can be retired cleanly when
  it lands.
- **mt#1144** — cockpit shell (PLANNING). Long-term UI consumer. Shape should match
  `WakeSignalPayload` rendering.
- **mt#1481** — `LoggingWakeSignalSink` (DONE). Producer-side seam this catalog builds on.
- **mt#1588** — MCP middleware enrichment (DONE). Pull-on-tool-call seam the §5 bridge
  extends.
- **mt#1593** — skill step on event-resumption toolkit (TODO). **Downstream consumer of
  this catalog.** Skill should recommend mechanisms by class first, then by concrete tool,
  citing this doc.
- **mt#1618** — pr-watch scheduler + production GithubPrClient (DONE). Closed the
  pr-watch wiring gap; the residual operator-notify-only gap was named in §4.3 and is
  now closed by mt#1725.
- **mt#1725** — `pr_watch` WakeSignalSink integration (DONE). Captures `parentSessionId`
  at registration, routes firings via `WakeSignalSink` to the registering agent's
  conversation context. Closes the §4.3 residual gap; promotes `pr_watch_create` from
  Class C (operator-only) to Class B (agent-context-deliverable).
- **mt#1315** — MCP signaling spike (DONE). `notifications/message` UI render path is
  unobserved from agent-side; recommendation locks in `exit-plus-message` for staleness
  only. Cited in §2.1 as the reason Class A is mostly aspirational.

### 7.2 Implementation follow-up

The §5 short-term bridge is non-trivial — DB schema migration + new domain sink + new
middleware + composition wiring + tests. **Tracked as mt#1661** (child of mt#1519):
_"Implement persistent wake-signal sink + pull-on-tool-call enrichment middleware
(mt#1519 follow-up)"_.

### 7.3 Long-term: shape for mt#1001 and mt#1144

The `WakeSignalPayload` shape (`src/domain/ask/wake-on-respond.ts:28-43`) is the canonical
event shape. mt#1001 (mesh push) and mt#1144 (cockpit) should both consume this shape so
the §5 bridge retires cleanly when mt#1001 lands — replace `PersistentWakeSignalSink` with
a `MeshPushWakeSignalSink` that publishes to LISTEN/NOTIFY, drop the `wake_pending` table
when subscribers can confirm delivery via the mesh layer.

---

## 8. Picking a mechanism — decision flow

```
Is this an external event the agent needs to know about?
├── No → just call the tool you already need.
└── Yes:
    │
    ├── Is the harness a Class A push transport (mt#1001 or future Claude Code render path)?
    │   ├── Yes → use it. Class A is the goal state.
    │   └── No → continue.
    │
    ├── Is there a queryable in-context query tool you can call once and unblock?
    │   ├── Yes (e.g., `session_pr_wait-for-review`) → use it.
    │   └── No → continue.
    │
    ├── Has the §5 bridge shipped, AND is the event Ask-mediated?
    │   ├── Yes → no agent action needed. Pending wakes deliver on the next tool call.
    │   └── No → continue.
    │
    └── Fall back to Class C: agent-driven poll.
        ├── If you're going to be active anyway → just call the query tool inline.
        ├── If you're idle but the wait is ≤270s → ScheduleWakeup (cache-warm).
        ├── If you're idle but the wait is 5min–1h → ScheduleWakeup at 1200s.
        └── If the wait is multi-hour or cross-session → CronCreate / /schedule.
```

This decision flow is a starting point — concrete cases (matrix in §3) override it. When
in doubt, choose the _class_ first, then the cheapest _mechanism_ in that class.

<!-- mt#1519 catalog v0.1 — see PR #988 for context. -->
