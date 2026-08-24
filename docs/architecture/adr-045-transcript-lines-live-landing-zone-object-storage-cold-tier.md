# ADR-045: Transcript storage — an insert-only `transcript_lines` table is the live landing zone; object storage becomes a cold seal-at-close tier

## Status

**Accepted** — 2026-08-24. Decided by the principal in answer to
[ask#8004](minsky://ask/f022e484-6047-44ad-8c2f-a6200064cb11), option
`Postgres lines now, object storage later as a cold tier` (responded 2026-08-24T15:07:59Z).
**Supersedes the mechanism of ADR-025**, which remains in the corpus as decision lineage and is
marked `Superseded by` at its own `## Status`. Written under mt#4501; the capture mechanism is
carried out by mt#2681.

## Decision (read this first)

**Raw transcript lines land in an insert-only Postgres table. Object storage stops being the live
system of record and becomes a one-way cold tier that seals a session after it closes.**

- An insert-only `transcript_lines(agent_session_id, line_ordinal, line jsonb)` table becomes the
  live landing zone; Postgres holds the raw corpus and the derived index both.
- ADR-025's upload-then-parse capture path is retired **before it ever ran** — `putRaw` has no
  production caller, so no object has been written and no migration is owed.
- The archive bucket and its domain client (mt#2680, DONE) survive. What changes is what they are
  FOR, not whether they exist.
- mt#2681's scope **inverts**: upload-then-parse becomes lines-table ingest.
- The raw corpus's recovery envelope becomes Supabase's **7-day daily-backup window** — measured,
  not assumed, and weaker than this decision's original framing claimed.

Accepting this = agreeing with the call. The seal trigger and the backup posture are named as
undecided below rather than settled here.

## Context

ADR-025 (Accepted 2026-07-08) made the raw transcript file in Supabase Storage the immutable system
of record and Postgres a rebuildable derived index over it. Two things happened to that decision.

**It carried an internal contradiction.** `docs/architecture/transcript-archive.md:27-28` states that
archive objects are immutable — _"A growing session produces a new snapshot object per capture;
nothing is overwritten or deleted. The store interface deliberately exposes **no delete**."_ Capture,
meanwhile, is incremental. An immutable store plus incremental capture means the archive retains
every prefix of every session. At the observed ~69 captures per session that projects to roughly 35x
the final corpus size — about 100 GB against the 1.4 GB the design was meant to relieve. Resolving
the contradiction means abandoning either no-delete or capture-time upload, and either is a new
decision rather than an amendment; mem#1107 records that conclusion.

**Nothing had been built on it.** `putRaw`'s only callers are `scripts/transcript-archive/smoke.ts`
and its unit tests (verified 2026-08-24). The retention projection is therefore a projection about an
unbuilt design, and changing course cost a document edit rather than a migration — which is what made
this the moment to decide.

Two of ADR-025's supporting premises had already been corrected by mt#4285 (PR #3134) without
touching its decision: the claim that archive objects are covered by the Supabase project backup
(false), and the lifecycle-policy leg of the `pg_largeobject` rejection (does not discriminate,
because Supabase Storage supports no S3 lifecycle configuration either).

## Decision drivers

- **Reversibility while the window is open.** No production object exists; no backfill has run.
- **Store count.** `decision-defaults.mdc §Datastores` makes Postgres the default and puts a bar in
  front of any second store. ADR-025 cleared that bar on an argument this decision reverses — see
  `## Consequences → The second-store bar, re-derived`.
- **Measured cost of the Postgres option.** The lines table expands the raw corpus by **1.714x**
  over a 21-session stratified sample, projecting roughly +1 GB (mem#773). **Read that figure with
  its decay caveat:** it was measured 2026-07-30/31, and mt#4345 has since fixed a write-
  amplification defect that some of mem#773's neighbouring numbers were partly measuring. The 1.714x
  expansion is a size ratio and is not affected by that fix; the surrounding update counts are.
- **A second live consumer for the bucket.** mt#4447 needs object storage for a non-transcript
  reason (a file-upload payload on an ask). This is the agent's reasoning, not part of the decision:
  it comes from ask#8004's option _description_, which is agent-authored, and mt#4447 is still in
  PLANNING with a failed gate. The principal endorsed the option's **label**, which commits to object
  storage surviving as a later cold tier and certifies nothing about mt#4447.
- **Answerability is untouched either way.** The governing constraint (principal, 2026-07-01) — that
  any question about a past session be answerable from our own durable storage, never from the
  on-disk JSONL at runtime — is satisfied by both options. It does not discriminate.

## Options considered

These are ask#8004's four, as presented to the principal.

- **Postgres lines now, object storage later as a cold tier (CHOSEN).** The insert-only table is the
  live landing zone; the archive is re-scoped to a one-way seal-at-close tier. Keeps the bucket work.
- **Postgres lines only.** Same landing zone, no second store planned at all. Rejected: mt#4447's
  uploaded files would then either go into Postgres or force a second store this option had just
  declined.
- **Keep object storage, but redesign it first.** Re-affirm ADR-025's direction and fix the retention
  blowup, the immutable-vs-incremental contradiction, and the backup gap before building. Rejected as
  the slowest path to unblocking four waiting tasks, for a design with no production caller.
- **Keep it open.** Rejected — mt#2681, mt#2583, mt#2580 and mt#4447's storage half all stay blocked,
  and the stated purpose of waiting ("read the evidence first") was exhausted.

## Consequences

### What changes for each task that inherited ADR-025's mechanism

| Task        | Status at decision | Premise it inherited from ADR-025                                                                                        | What this ADR does to it                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mt#2681** | BLOCKED            | Capture writes the raw file to the archive FIRST, durably confirms, then parses                                          | **Scope inverts.** Capture appends lines to `transcript_lines`; parsing reads from the table. Its two recorded blockers dissolve with the mechanism that created them. Must be re-specced before implementation — do not implement from its current text.                                                  |
| **mt#2580** | TODO               | The six blob readers re-point to the object-store archive; the pre-drop gate is "archived to the bucket"                 | **Target changes, task survives.** The blob still drops and the readers still re-point — to `transcript_lines` plus the promoted columns. The pre-drop gate becomes "lines captured in Postgres," which removes its dependency on a bucket backfill.                                                       |
| **mt#2583** | PLANNING           | Queryable tool-call/tool-result columns in Postgres, with _"full fidelity stays in the raw archive"_ (its title)         | **Rationale intact, fallback store changes.** Column promotion is still right and still parse-time-derived; full fidelity now stays in `transcript_lines`. The title's parenthetical is stale.                                                                                                             |
| **mt#2682** | TODO               | Existing `agent_transcripts` blobs must be archived to object storage before the column can be dropped                   | **Re-point, do not close.** The backfill is still needed — the surviving blobs are the only copy for the sessions whose JSONL is gone — but its destination becomes the lines table. Its `harness='legacy'` handling decision (pre-extracted `TranscriptMessage[]`, not raw JSONL) carries over unchanged. |
| **mt#2715** | TODO               | Supabase database backups do not cover Storage objects, so an unbacked bucket would hold the only copy of the raw corpus | **Survives, re-scoped; stops gating.** The raw corpus moves into Postgres, so the bucket is no longer the only copy and this task no longer gates the mt#2580 drop. It becomes the owner of the DR question the new posture raises — see below.                                                            |
| **mt#3954** | PLANNING           | Bucket provisioning is a transcript-storage prerequisite                                                                 | **Not orphaned; re-justified.** Provisioning survives, because the bucket survives. Its justification moves from transcripts to mt#4447, which is the tier that now needs it live.                                                                                                                         |
| **mt#4447** | PLANNING           | Its storage half was gated on ask#8004 rather than decided independently                                                 | **Ungated.** Object storage exists and the live transcript path no longer needs it, so mt#4447 may claim the bucket without re-arguing the second-store bar from scratch — the bar is cleared below, for the cold tier, and mt#4447's own use rides on the same store.                                     |

### What changes for two other ADRs

Two accepted or proposed records build on ADR-025 and are easy to miss, because the supersession
reads as a task-graph event rather than a corpus one.

- **ADR-040** (_The transcript scrub gate binds at trust-boundary crossings_, Proposed) — extends
  ADR-025 §Security/access-control's _"secrets, tokens, and PII"_ as _"the content-risk premise this
  extends from storage to read surfaces."_ **Reasoning intact.** That premise is about transcript
  CONTENT, not about where content is stored, and ADR-040's gate binds at boundary crossings either
  way. One thing worth naming: the raw lines now sit in Postgres rather than a private bucket, so the
  content-risk surface moves inside the database, where ordinary query paths can reach it. That
  widens who must not leak it; it does not change where ADR-040's gate binds.
- **ADR-044** (_An entity thread's agent turns derive from the harness transcript_, **Accepted**
  2026-08-19, decided by the principal via ask#9257) — cites ADR-025 as precedent: _"ADR-025 decided
  for the transcript subsystem that the raw transcript is the immutable system of record and Postgres
  is a rebuildable derived index. This ADR applies that same stance one layer up."_ **Its decision is
  unaffected; that one citation no longer holds as written.** The half ADR-044 actually relies on —
  the ingested copy is the record and the file is a replay journal, which it states independently at
  _"The file is not the record"_ — survives completely. The half that does not survive is _"the raw
  transcript file is the immutable system of record"_: under this ADR the system of record is the
  ingested lines in Postgres. **This ADR does not edit an accepted, principal-decided record**; a
  correction note pointing here has been added to ADR-044's `## Corrections`, leaving its decision
  and its lineage untouched.

### The second-store bar, re-derived for the cold tier

`decision-defaults.mdc §Datastores` reads: _"**Datastores**: persistence/pubsub/state →
Postgres-via-Supabase; 2nd store: ADR+gap+owner."_ Object storage survives this decision, so a second
store is still in the design and the bar still applies. **ADR-025's clearance is not inheritable** —
its lead criterion was that _"a cold, immutable, multi-hundred-MB-and-growing blob is a workload
Postgres serves poorly,"_ and this decision hands exactly that workload to Postgres. Re-derived:

- **ADR** — this record.
- **Gap** — the cold tier's gap is _durability independent of the primary store_, not _relieving
  Postgres of a workload it serves poorly_. A sealed, closed-session object is written once, never
  read on any live path, and sits outside the database's failure domain. That is a different
  justification from ADR-025's and has to be stated as one.
- **Owner** — mt#3954 owns provisioning; mt#2715 owns the durability posture. The seal trigger has
  no owner yet, which is why it is listed as undecided rather than described.

### Disaster-recovery posture (measured, not assumed)

Under this decision the raw corpus lands in Postgres, so its protection is the database's. Measured
against production on 2026-08-24, not inferred:

```
$ supabase backups list --project-ref yvkkrpyjhoiilmizlnac
{"region":"us-west-2","walg_enabled":true,"pitr_enabled":false,"backups":[ ... 9 COMPLETED
 physical backups, oldest 2026-08-17T13:38:14Z ... ]}
```

That project ref is production: `docs/supabase-pooler-switch.md` sets Railway's
`MINSKY_PERSISTENCE_POSTGRES_URL` to `db.yvkkrpyjhoiilmizlnac.supabase.co`.

**So the envelope is a 7-day daily-backup window, and point-in-time recovery is off.** Hardware
durability is not the concern; a logical loss — a bad migration, a bad script, credential compromise
— discovered more than 7 days later is unrecoverable for the raw corpus. This is stronger than
ADR-025's position, where the equivalent corpus sat in a bucket that database backups do not cover at
all, and it is weaker than "backed up" unqualified.

**Do not write "daily backups plus optional PITR."** Per Supabase's own documentation, enabling PITR
_disables_ daily backups because it supersedes their granularity — the two are alternatives, not a
sum. PITR is a paid add-on (~$100/mo at 7-day retention, ~$400/mo at 28-day) requiring at least the
Small compute add-on, and at the 7-day tier it buys finer granularity without extending the window.

### Vendor premises this ADR rests on, each with the check that verifies it

ADR-025 accumulated three unverified Supabase-capability premises over its life, two corrected by
mt#4285 and one found while writing this record. Every one was plausible, load-bearing on the
comparison between the options, and unchecked at write time. The remedy is to make re-checking cheaper
than re-discovering:

| Premise                                                                                      | Verify with                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Database backups do NOT cover Storage object contents (only `storage.objects` metadata)      | [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups) — verified 2026-08-18 (mt#4285), re-read 2026-08-24 |
| PITR is a paid add-on and REPLACES daily backups rather than supplementing them              | Same page — read 2026-08-24                                                                                                         |
| Production has PITR off and a 7-day daily window                                             | `supabase backups list --project-ref yvkkrpyjhoiilmizlnac` — measured 2026-08-24                                                    |
| Supabase Storage supports no S3 lifecycle configuration, versioning, object lock, or tagging | [Supabase: S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility) — verified 2026-08-18 (mt#4285)             |

A reader who doubts any row runs its check rather than re-deriving the argument.

### Also true

- Postgres grows by roughly +1 GB for the raw corpus (1.714x expansion — mem#773, with the decay
  caveat in `## Decision drivers`). Against a database measured at 7,422 MB on 2026-08-22 (mem#1207),
  and an 8 GB Pro figure that is an overage charge at $0.125/GB rather than a wall.
- ADR-025's **promoted-column register** survives intact, along with both properties it requires
  (derived at parse time, backfilled by re-parse). The register's reason for existing does not depend
  on where the raw lives.
- ADR-019's stage-1 landing zone moves a second time: ADR-025 moved it from the PG `transcript` jsonb
  to the archive; this moves it to `transcript_lines`. ADR-019 remains Proposed.
- The on-disk Claude Code JSONL stays throw-away after successful capture, and nothing reads it at
  runtime. Unchanged from ADR-025.

## What this ADR does NOT decide

- **What triggers a seal, and what the cold tier is for beyond durability.** The chosen option says
  "later" and this record does not invent a trigger, because a tier with a described purpose and no
  trigger is a promise that never fires. **Owner: mt#3954** for provisioning, **mt#2715** for the
  durability posture it serves. Neither is scheduled by this ADR.
- **Whether to buy point-in-time recovery, or keep an independent copy gating the move.** A paid plan
  upgrade is a vendor commitment reserved to the principal. Routed as
  [ask#9995](minsky://ask/af68c3e5-a676-4610-bf65-8493311232fd), parented to mt#4501, owned by
  mt#2715. This record states the measured posture and does not pre-empt the answer; the answer
  decides only whether mt#2715's re-scope leaves it gating.
- **The ingest mechanism itself** — table shape, ordinal assignment, idempotency under re-ingest and
  high-water-mark regression. mt#2681, re-specced.
- **When the `agent_transcripts.transcript` column drops, and how the six readers re-point.** mt#2580.
- **Embedding and FTS granularity.** mt#2585, which carries its own 2026-08-22 re-measurement showing
  its urgency argument predates mt#4345.

## Cross-references

**Supersedes:** ADR-025 (mechanism only; its context, its `## Corrections`, and its promoted-column
register all stand). **Related ADRs:** ADR-019 (pipeline staging — stage-1 landing zone moves again),
ADR-017 (capture triggers), ADR-018 (canonical persistence pattern + require-Postgres — which this
decision moves toward rather than away from), ADR-013 (filtered vector search), ADR-002 (persistence
providers), ADR-040 and ADR-044 (both inherit ADR-025 — see `## Consequences`).

**Decision record:** ask#8004 (the principal decision this ADR formalizes, answered 2026-08-24);
ask#9995 (the open DR question this ADR does not settle).

**Tasks:** mt#4501 (this record) · mt#2581 (umbrella) · mt#2681 (ingest rewrite — re-spec) · mt#2580
(blob drop) · mt#2583 (tool-call columns) · mt#2682 (backfill — re-point) · mt#2715 (DR posture) ·
mt#3954 (bucket provisioning) · mt#4447 (the bucket's non-transcript consumer) · mt#2585 (embedding
granularity) · mt#4285 (ADR-025's two corrected premises) · mt#2680 (the bucket + client that
survive) · mt#2584 (the spike that is still the evidence base for the reader inventory).

**Memory:** mem#1207 (fresh 2026-08-22 measurements) · mem#1107 (the three Fable advisories and the
prior-art survey, relayed-vs-verified marked) · mem#773 (write amplification and the 1.714x
expansion, with its measurement-decay header) · mem#1233 (the handoff carrying this decision).
