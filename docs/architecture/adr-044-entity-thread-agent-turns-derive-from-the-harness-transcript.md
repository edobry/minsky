# ADR-044: An entity thread's agent turns derive from the harness transcript; the stdout tap is an unconfirmed echo

## Status

**Accepted** — 2026-08-19. Decided by the principal in answer to ask#9257, option
`adopt-c-read-time`: agent turns derive from the ingested transcript, joined at read time. Proposed
2026-08-18. Supersedes the storage decision recorded in mt#3363 §Storage decision.
Carried out by mt#4319.

## Decision (read this first)

**Split an entity thread's record by AUTHOR: agent turns become a derived projection over ingested
transcript rows; operator turns and host notices stay first-party in `entity_thread_turns`; the
stdout tap stops being a durable write and becomes an explicitly unconfirmed live tier.**

Accepting this means agreeing that:

- A failed write on the stdout path stops being data loss, because the record is elsewhere.
- `entity-thread-reply-buffer.ts` (~560 lines of compensation) and its content+clock-skew matching
  are deleted, not extended.
- The panel gains a real two-state render — _streaming_ vs _recorded_ — instead of silently
  presenting unconfirmed state as final.
- One thread's turns stop having mixed scrub provenance (see §Consequences).
- We take a new coupling: transcript-extractor defects and a quarantined transcript become
  operator-visible thread defects.

Rejecting it means keeping `entity_thread_turns` as the system of record and continuing to close
gaps with reconcilers — which is the status quo as of mt#4073, and is a defensible choice; see
§Option B.

## Context

### What an entity thread is

An operator opens a cockpit detail page for an entity (an ask or a task) and chats with an agent
about it inline. Mechanically the daemon spawns the genuine `claude` binary as a child
(`src/cockpit/driven-session-host.ts`), writes operator messages to its stdin, and reads
newline-delimited stream-json from its stdout.

### The same output is recorded twice, by unrelated mechanisms

1. **The stdout tap.** `createEntityThreadReplyRecorder` (`src/cockpit/entity-thread-launch.ts`)
   subscribes to the event stream and writes each agent reply into `entity_thread_turns`, keyed by
   a derived `local_id` (`entity-thread:ask:<uuid>`). **This is what the panel renders.**
2. **The transcript path.** The `claude` binary writes its own session JSONL to
   `~/.claude/projects/<slug>/<id>.jsonl` — the daemon does not write this. The cockpit's
   transcript-watcher (`src/cockpit/transcript-watcher.ts`) tails it and ingests into
   `agent_transcripts` / `agent_transcript_turns`, keyed by `agent_session_id`.

Two writers, two identity schemes, and until mt#4073 nothing joined them.

### What that produced

Four distinct production failures inside roughly 24 hours (2026-08-11/12), all from this one root:

- **mt#4036** — a dropped reply rendered as "the agent never answered."
- **mt#4066** — the "still retrying" notice could never reach "lost," because the age-out was
  gated behind a successful read of the very store that was down. Fixed.
- **mt#4073** — the in-memory buffer died with a daemon restart and took the operator's notice with
  it, leaving a hole with nothing saying so.
- **mt#4093** — a thread silently swapped to a fresh agent with no history while the panel rendered
  unbroken continuity.

In the originating incident the reply was never actually lost: it sat in `agent_transcript_turns`
(conversation `64f990d3-…`, turn_index 25) while the panel showed nothing. Recovering it required a
manual SQL query.

### What has since shipped, and why this ADR is not a green field

**mt#4073 shipped a reconciler** (`src/cockpit/entity-thread-transcript-reconciler.ts`, plus the
pure decision core at `packages/domain/src/transcripts/entity-thread-reconcile.ts`). Its docblock
states the shape deliberately: _"The recorder stays the fast path; these rows are durable
incremental state; a sweeper closes the difference,"_ grounded in ADR-017's house default — _"don't
depend on cooperative shutdown; depend on durable incremental state plus reconciliation."_

That is **Option B below, already in production.** This ADR therefore does not ask "what should we
build"; it asks whether the reconciler is the destination or a way station.

### The original decision, and the state of its two justifications

mt#3363 §Storage decision reasoned:

> `agent_transcripts` is an **ingest-shaped** table, not a general conversation store... A
> cockpit-native thread has no JSONL and no harness, so writing threads into it would fight the
> ingest pipeline and corrupt its system-of-record semantics. **Therefore: do not dual-write
> threads into `agent_transcripts`.**

`packages/domain/src/storage/schemas/entity-threads-schema.ts:14-17` carries a second, independent
justification — an empirical one:

> ...33 `driven_sessions` rows carried 6 `harness_session_id`s, of which 2 had reached
> `agent_transcripts` — roughly 6% end-to-end coverage...

Both legs need honest treatment, and they fail differently:

- **The ontology leg was false when written and is false now** (verified). Every entity thread that
  exists is driven by a `claude_code` harness and does write JSONL — that is how the mt#4036 reply
  was recovered. The decision generalized for a cockpit-native, no-harness thread that does not
  exist.
- **The coverage leg was true when written and has since aged out** (verified 2026-08-18 by direct
  query, not relayed). All **9** `entity-thread:` rows in `driven_sessions` carry a
  `harness_session_id`, and every one has ingested turns in `agent_transcript_turns` — 7, 42, 15,
  12, 8, 109, 14, 5, 9. Against mt#3363's measured ~6%, current-conversation coverage is 9/9.
  **One bound on that figure:** `driven_sessions` holds only a thread's CURRENT conversation id,
  because the upsert overwrites prior ids (mt#4093). So this measures coverage of the live
  conversation, not of a thread's full span. Span coverage cannot be measured until the binding
  table proposed below exists — which is an argument for that table, not against Option C.

## Decision drivers

- **Author asymmetry is the load-bearing constraint.** Operator turns cannot be derived from the
  JSONL, for three independent reasons: the seed prompt, the `[minsky] This conversation was
resumed…` notices and the operator's own messages are all structurally identical `user` records,
  so authorship is unrecoverable; `turn-extractor.ts` supersedes consecutive user lines by policy
  ("the last one wins"), which is lossy for two operator messages before a reply; and a message
  that FAILED delivery never reaches the JSONL at all — the POST route stores the operator turn
  before forwarding to a possibly-dead stdin, so the daemon records _intent_ while the file records
  _delivery_. For operator turns the daemon is the origin and there is no upstream record, so
  keeping them first-party is not a dual write.
- **The transcript path is the policied path.** The credential scrubber
  (`packages/domain/src/transcripts/credential-scrubber.ts`) runs on the ingest path
  (`agent-transcript-ingest-service.ts`). The stdout recorder has **zero** scrub references
  (verified). Raw reply text lands in `entity_thread_turns` unscrubbed.
- **Precedent already exists in this corpus.** ADR-025 decided for the transcript subsystem that
  the raw transcript is the immutable system of record and Postgres is a rebuildable derived index.
  This ADR applies that same stance one layer up rather than inventing a shape.
- **The file is not the record.** ADR-025 §Context measured on-disk JSONL as retention-bounded, not
  durable. The system of record is our INGESTED copy; the file is a replay journal for the ingest
  window and must never be a read-time dependency.

## Options considered

### Option A — status quo hardened

`entity_thread_turns` remains the record; keep closing gaps with buffers and repairs.

Rejected on receipts: four incidents in 24 hours, ~560 lines of compensation machinery in
`entity-thread-reply-buffer.ts`, content-plus-clock-skew matching (`isReplyAlreadyStored`) serving
as a correctness mechanism, and a second copy the scrubber never touches.

### Option B — dual-write plus reconciler (SHIPPED, mt#4073)

Keep the stdout write as the fast path; a sweeper repairs `entity_thread_turns` from
`agent_transcript_turns`.

This is the current state and it is genuinely defensible: it follows ADR-017's reconciliation
default, it closed the restart hole, and it required no change to the read path. Its costs are that
two pipelines are maintained where one is strictly better-sourced; that the repair must match turns
by content heuristics indefinitely; and that it leaves the scrub asymmetry and the unconfirmed-state
render problem untouched.

### Option C — derived read model, split by author (RECOMMENDED)

- **Agent turns**: system of record is the harness conversation — JSONL ingested into
  `agent_transcript_turns`, and per ADR-025 eventually the object-store archive.
- **Operator turns, host notices, and the thread↔conversation binding**: first-party daemon tables.
- **The panel view**: a merge of first-party turns with agent prose filtered from
  `agent_transcript_turns` across the thread's ordered conversation ids, timestamp-ordered (same
  host, same clock).
- **The stdout subscriber stops persisting.** The in-memory event log becomes an explicitly
  ephemeral streaming tier the UI renders as unconfirmed.
- **`entity-thread-reply-buffer.ts` is deleted.** Its replacement is an ingest-lag indicator
  (newest stdout event vs newest ingested turn for the live conversation id) plus the watcher's
  existing failure counters. mt#4036's UX intent survives as that indicator.

**Sub-decision C1 vs C2** — materialize derived agent turns back into `entity_thread_turns`
(write-behind) versus a read-time join. **Recommend the read-time join**: no third copy, and the
GET is already a database read. Materialize later only if the join measurably hurts.

**Required either way**: an append-only `driven_session_conversations (local_id,
harness_session_id, harness, actuator_generation, adopted_at, adoption_reason)` binding. A thread's
history spans several conversation ids (a daemon restart can spawn a fresh seeded child rather than
resuming), and the `driven_sessions` upsert overwrites the prior id — mt#4093's named data loss. No
table carries this today (verified: no such table exists in the schema tree).

**Widened from `entity_thread_conversations` on 2026-08-19**, per RFC `3bb937f0` §5 — see
§Reconciliation below. The overwriting upsert is `onConflictDoUpdate({ target:
drivenSessionsTable.localId, set: values })` in
`packages/domain/src/transcripts/driven-session-registry-store.ts:107`, a store shared by the
principal channel (`principal-channel-launch.ts`, `principal-channel-actuator.ts`) and the
WS-driven callers (`routes/driven-sessions.ts`) as well as entity threads. A thread-scoped table
would fix one caller's instance of a hole that lives in all of them.

## Consequences

**Good.** A failed stdout write stops being data loss. The compensation machinery is deleted rather
than extended. Thread history inherits the scrubber. The unconfirmed tier becomes visible to the
operator instead of being silently presented as final. The conversation-span binding makes mt#4093's
swap a recorded fact rather than an inference from disk.

**Bad, and to be accepted explicitly.** Extractor defects (the mt#3883 fusion class, mt#3975
supersession) become operator-visible thread defects. A quarantined transcript
(`ingest_quarantined_at`) freezes a thread's derived history, so the thread UI must surface that
state rather than render a silent truncation. And the derived path adds ingest latency to reply
visibility. Both constants are verified from source — `DEFAULT_DEBOUNCE_MS = 400`
(`transcript-watcher.ts:53`) against `POLL_INTERVAL_MS = 3_000` (`EntityThreadPanel.tsx:45`) — so
the coalescing window sits well under one poll cycle. **Bound:** 400ms is the debounce alone, not
end-to-end ingest latency, which adds tail, parse and write on top. The floor is verified; the
total is not, and measuring it is a precondition to flipping the read path.

**Mixed provenance is a transitional hazard worth naming.** Under Option B as shipped today, a
single thread can hold recorder-written turns (unscrubbed) beside reconciler-recovered turns
(scrubbed at ingest). Whichever option is chosen, that mix should not persist.

**Migration.** Before the read path flips, run a one-time reconciliation of existing
`entity_thread_turns` agent rows against ingested turns, so the change does not silently alter
already-rendered history.

## What this ADR does NOT decide

Four adjacent problems surfaced during the investigation. They are upstream of storage and must not
be smuggled into this decision:

1. **Daemon restart churn.** Every one of the four incidents is restart-adjacent. Reducing churn
   changes the cost/benefit of everything above.
2. **The `cacheNegative` latch** (`db-providers.ts`) — one failed probe at boot latching null for
   the daemon's life. A cross-cutting availability defect that would degrade Option C's ingest leg
   just as happily.
3. **Reachability has three answers.** "Is an agent reachable for this thread?" is currently
   answered against registry presence, actuator liveness, and the persisted row, and callers
   disagree. A storage decision does not fix this and should not pretend to.
4. **The unconfirmed tier needs a transport.** The panel is poll-only by explicit decision, and a
   3s poll cannot render streaming. Either accept sub-poll invisibility or revisit that decision —
   consciously, not by inheritance.

## Reconciliation with RFC 3bb937f0 (added 2026-08-19, after acceptance)

This ADR was drafted, decided and accepted **without citing the RFC that is its own proximate
ancestor**: _Subject-scoped engagement — the office, the incumbency, and the attachment event_
(Notion `3bb937f0-3cb4-81d8-a571-ca8bcca9051c`, **Draft** 2026-08-13,
<https://app.notion.com/p/3bb937f03cb481d8a571ca8bcca9051c>). Its §6 is titled _"Disposition of
ADR-040"_ and argues that the entity-thread system-of-record ADR should _"proceed now, narrowed"_ —
this document is that ADR, renumbered because 040 was taken meanwhile by the scrub-gate ADR.

The omission is a corpus-coverage gap, not an oversight of retrieval: Minsky's accepted decision
records are split by policy between `docs/architecture/` and Notion, and the in-repo passes cannot
reach the second. Surfaced by `/plan-task mt#4319`'s gate (p) pass (c) on 2026-08-19.

**The RFC is a Draft, so it does not GOVERN this decision** — nothing here is retracted. What
follows is the narrowing its §6 asks for, applied:

1. **Scope of the claim.** The binding table is the system of record for the **attachment-event
   series** — which conversation was adopted, when, and why. It is NOT the system of record for
   "the conversation" and it does not establish line-of-work identity.
2. **Disjoint coverage with mt#3943.** `conversation-transitions.jsonl` structurally cannot record
   these swaps: `writeConversationMapping` emits a transition only when a prior mapping exists on
   the SAME pid, and a daemon respawn is a new pid with no prior mapping. **Transition** = a
   conversation replaced in the same seat (`/clear`, in-process resume, compact, fork). **Adoption**
   = a conversation attached to the same subject-surface across seats. Neither covers the other.
3. **mem#938 compliance.** No identity is minted. `local_id` already exists and is deterministically
   derived; this table is an edge relation, and mem#938's own text anticipates it — post-mt#3900 the
   data is _"recoverable by a join once edges exist."_ The line of work stays a derived join; this
   makes its edges durable.
4. **Generalization.** Recorded above, in §Option C.
5. **Consumer.** mt#3695 (lineage ontology, PLANNING) is the task that decides what the series
   MEANS. This ADR deliberately does not — it captures perishable edges ahead of the ontology that
   will interpret them, which is mt#3943's standing precedent.
6. **Anti-reification.** The series is a fold over adoption rows and the incumbency is the interval
   between consecutive ones. Both are derived. Do not mint an id-space for either — the temptation
   appears first here, which is why the discipline is stated here.

**Not taken from the RFC**: its §3 concept and naming (_matter / case / watch_), which remain the
principal's to decide, and its larger unification across entity threads, task work and collision
detection. Adopting §5's schema does not accept §3's ontology.

## Cross-references

ADR-025 (transcript storage: raw file as system of record, Postgres as rebuildable derived index —
the precedent this extends) · ADR-017 (continuous-watch capture; the reconciliation default
mt#4073 invoked) · ADR-040 (scrub gate binds at trust-boundary crossings — adjacent, and does not
cover the recorder/ingest asymmetry described above) · mt#3363 §Storage decision (the decision this
supersedes) · mt#4036, mt#4066, mt#4073, mt#4093 (the four incidents) ·
`packages/domain/src/storage/schemas/entity-threads-schema.ts:14-17` (the coverage justification).
