# ADR-025: Transcript Storage — Raw Archive in Object Storage as System of Record, Postgres as Rebuildable Derived Index

## Status

**SUPERSEDED** by
[ADR-045](./adr-045-transcript-lines-live-landing-zone-object-storage-cold-tier.md) — 2026-08-24.
Originally **ACCEPTED** 2026-07-08.

**Do not implement from this record.** ADR-045 reverses the mechanism below: an insert-only
`transcript_lines` table in Postgres becomes the live landing zone, and object storage is re-scoped
from the immutable system of record to a one-way cold seal-at-close tier. The principal decided this
in answer to ask#8004 on 2026-08-24; mt#4501 wrote the successor record.

**What is superseded, and what still stands.** Superseded: `## Decision`, the upload-then-parse
capture path, and the `## Consequences` items that depend on the archive being the live landing zone.
Still current and still worth reading: `## Context` (the 2026-06-30 size investigation and the mt#2584
spike, which remain the evidence base for the six-reader inventory and the two-blob-schema finding),
the `## Corrections` below, and the `## Promoted-column register`, which ADR-045 carries forward
intact along with both properties it requires. The text is retained in full as decision lineage; the
two mt#4285 corrections are unaltered.

Why a new record rather than an amendment: this ADR's own text declares archive objects immutable
while capture is incremental, so resolving that contradiction means abandoning either no-delete or
capture-time upload — a new decision either way. mem#1107 records that conclusion.

## Corrections

### 2026-08-18 — the archive-backup premise is false (mt#4285)

This ADR asserted, in two places, that archive objects are covered by the Supabase project backup. They
are not. Supabase's own documentation states: _"Database backups do not include objects you store via the
Storage API, as the database only includes metadata about these objects"_ and _"Restoring an old backup
does not restore objects you deleted after that backup"_
([Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)). The same finding was
reached independently by mt#2680 and recorded in `docs/architecture/transcript-archive.md §Backup /
disaster-recovery posture (VERIFIED 2026-07-08)` — the same day this ADR was accepted. It stood
uncorrected here for 41 days.

Original text, retained as decision lineage:

- **§Decision, criterion (d):** _"operational ownership is the existing Supabase vendor relationship — no
  new on-call, and archive objects are covered by the Supabase project backup."_
- **§Consequences, disaster recovery:** _"Archive objects are covered by the Supabase project backup; the
  bucket must be treated as a critical, backed-up asset (verify the backup policy, not assume it)."_

**What this changes, and what it does not.** The DECISION is untouched: this ADR remains ACCEPTED and its
mechanism stands until superseded. What changes is criterion (d)'s honesty. (d) was one of four criteria
offered to clear `decision-defaults.mdc §Datastores`' second-store bar, and it is a conjunction — the
"no new on-call / existing vendor relationship" clause holds, the backup clause does not. So (d) is
partially, not fully, met. The residual risk is real and unmitigated: logical loss of an unbacked bucket
that would hold the only copy of the raw transcripts for ~60% of sessions. **mt#2715** (off-Supabase
mirror) owns that gap and is still TODO.

Whether a partially-unmet criterion changes the second-store choice is a separate and still-open question
— [ask#8004](minsky://ask/f022e484-6047-44ad-8c2f-a6200064cb11) puts it to the principal, alongside an
in-Postgres `transcript_lines` alternative whose storage cost was measured in mem#773. This correction
deliberately does not pre-empt that decision. An accepted ADR should not carry a false premise while
awaiting supersession, and it should not be quietly reversed by the agent that noticed the premise was
wrong.

### 2026-08-18 — the lifecycle-policy leg of the `pg_largeobject` rejection does not hold on Supabase (mt#4285)

§Alternatives rejects `pg_largeobject` on three grounds, the third being that in-Postgres blobs "cannot
carry a separate retention/lifecycle policy." That is true of `pg_largeobject` and misleading as a
comparison, because **Supabase Storage does not support S3 lifecycle configuration either**:
`GetBucketLifecycleConfiguration` and `PutBucketLifecycleConfiguration` are both marked unsupported, as
are bucket versioning ("S3 versioning is not supported. Supabase Storage does not enable S3's versioning
capabilities"), object lock, and object tagging
([Supabase: S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility), verified
2026-08-18). A retention policy is application code you write and schedule under BOTH options, so this
leg does not discriminate between them.

Scope note: this is a SECOND instance of the same defect class as the correction above — an unverified
factual premise about Supabase load-bearing in this ADR's reasoning — found while fixing the first, and
patched in the same round rather than split into a follow-up. It records the verified fact and stops
there. It does NOT re-weigh the two remaining legs (backup-set consumption, independent HTTP URL), and
it does NOT revisit the decision; that is [ask#8004](minsky://ask/f022e484-6047-44ad-8c2f-a6200064cb11).

## Context

The transcript substrate (`agent_transcripts` / `agent_transcript_turns`, behind
`transcripts_search` / `transcripts_search-text`) stores each agent session two ways at once.
A 2026-06-30 investigation (prompted by "why are transcripts so large?") measured the prod DB at
1.5 GB and found it dominated **not** by conversation text but by a redundant raw blob:

- `agent_transcripts.transcript` (jsonb, the full raw turn array per session) = **623 MB** (~40% of
  the DB; avg 594 KB/session, max 16 MB), dominated by verbatim tool-result payloads.
- The actual conversation text in `agent_transcript_turns` (`user_text` + `assistant_text`) = **21 MB**;
  `tool_calls` = 34 MB; per-turn `embedding` = 161 MB; `fts_text` = 27 MB; + ~320 MB of indexes.

The raw `transcript` blob is a redundant intermediate: it is written by the ingest service (appending
JSONL lines via `COALESCE(transcript,'[]') || EXCLUDED.transcript`) and read to derive the per-turn
rows, which are themselves the queryable surface. It duplicates content that is also on disk as the
Claude Code JSONL (`~/.claude/projects/.../*.jsonl`) and, in parsed form, in the per-turn rows.

A read-only spike (mt#2584) established three facts that shape this decision:

1. **The on-disk JSONL is not a durable system of record.** Only 428 `.jsonl` survive locally (oldest
   mtime 2026-05-23, a ~5-week window) against ~1,073 ingested sessions since ~April; daemon-ingested
   sessions ran on Railway's ephemeral disk. The **majority of ingested rows have no reachable source
   file.** "Rebuild from the on-disk JSONL" is not available for them.
2. **The per-turn rows are a lossy projection of the raw.** They intentionally drop assistant `thinking`
   blocks (`extractAssistantText`, `turn-extractor.ts:72-80`), tool-**results** entirely (`extractUserText`
   excludes `tool_result` blocks, `turn-extractor.ts:90-98`), spawn-boundary tool-results, per-message
   metadata (uuid, parentUuid, model, token usage, stop_reason), and non-paired/system lines. So Postgres
   today cannot losslessly reconstruct the original conversation.
3. **The raw blob has six readers, not two:** (1) the incremental read-back after each ingest upsert
   (`agent-transcript-ingest-service.ts:190` → `writeTurnsForTranscript`); (2) the batch reconciliation
   sweep `extractTurnsForAllTranscripts` (`turn-writer.ts:154`, run by `index-embeddings`); (3)
   `getTranscript` (`provenance/transcript-service.ts:161`, feeding authorship judging at
   `session-merge-operations.ts:1290` and the unasked-direction post-merge scan); (4) `summary-pipeline.ts`;
   (5) `metadata-extraction-pipeline.ts`; and (6) `assembleSessionContextSnapshot`
   (`session-context-snapshot.ts:177`), the cockpit context-inspector. Only reader (6) needs the full raw
   content (thinking blocks + message structure) at runtime; the rest need only text.

**Two blob schemas exist.** The modern ingest (`AgentTranscriptIngestService`) stores raw JSONL
(`RawTurnLine[]`). A **legacy** path (`AgentTranscriptService.ingestTranscript`,
`provenance/transcript-service.ts:100-157`, `harness='legacy'`) stores a **pre-extracted**
`TranscriptMessage[]` (`{type, role, content, timestamp, uuid, model}`) that has _already_ lost thinking,
parentUuid, per-line metadata, and full message structure. These are not interchangeable — a legacy blob
is not a raw original.

The governing constraint (principal, 2026-07-01): we must be able to answer **any** question about a
past session from **our own durable storage**, and must **never** depend on the original on-disk JSONL
at runtime — after parse it is throw-away. The open question was _where_ the full-fidelity original
should live so Postgres can shed the blob without losing answerability.

## Decision

We will make **the raw transcript file, stored in object storage (Supabase Storage), the immutable
system of record**, and treat **Postgres as a rebuildable derived index** over it.

- **Ingest becomes upload-then-parse.** On capture, the raw transcript file is written to the object-store
  archive **first** (keyed by `agentSessionId` + harness), durably confirmed, and only then parsed into
  the Postgres derived tables. This revises the stage-1 landing zone of the draft ADR-019 proposal: the
  raw lands in the archive, not in `agent_transcripts.transcript`, and extraction (ADR-019 stage 2) parses
  from the archived raw, not from a PG blob.
- **The local Claude Code JSONL is throw-away** after a successful upload. Nothing reads it at runtime.
- **The derived index surfaces the fields the hot query/UI paths need — including a small set of
  currently-dropped fields promoted to columns.** Specifically, the fields the cockpit context-inspector
  (`assembleSessionContextSnapshot`) consumes — assistant `thinking` presence/text and `parentUuid`, plus
  whatever `assistantContentKind` needs — are promoted onto `agent_transcript_turns` so that **live UI path
  is served entirely from Postgres**, not from a per-request archive fetch. The archive is thereby a
  **cold** path (replay, audit, re-derivation), not a hot one. (If a needed field proves impractical to
  columnize, the fallback is an application-level cache in front of archive fetch; a naked per-request
  archive fetch on an interactive endpoint is not acceptable. The exact promoted set is fixed by auditing
  what `session-context-snapshot` reads, and that audit precedes the blob drop.)
- **Postgres is fully rebuildable** from the archive by re-parsing. New structured fields (a tool-result
  table, richer metadata, a different embedding granularity) are a re-parse away — we are not locked to the
  fields captured at first ingest.
- **The `agent_transcripts.transcript` jsonb column is dropped** — only **after** existing blobs are
  archived (see backfill), reclaiming most of the ~623 MB from Postgres (net of the small promoted-column
  footprint added back).

**This adds object storage as a second store, and clears the `decision-defaults.mdc §Datastores` bar
explicitly** (rather than claiming the bar doesn't apply): (a) a cold, immutable, multi-hundred-MB-and-
growing blob is a workload Postgres serves poorly — it is 40% of the DB and unbounded; (b) the evidence is
quantified from the 2026-06-30 spike; (c) this ADR is the required amendment naming Supabase Storage and
why `pg_largeobject` was not preferred (below); (d) operational ownership is the existing Supabase vendor
relationship — no new on-call. **⚠ (d) is only PARTIALLY met: its original second clause claimed archive
objects are covered by the Supabase project backup, which is false (corrected 2026-08-18 — see
`## Corrections`; the unmitigated gap is owned by mt#2715).** Postgres
remains the single source of truth for all structured **product** state; the archive is a raw landing zone
that the disposable index is built from — the data-lake shape, consistent with "the search index is
derived data" (memory `70b595dc`, ADR-013/ADR-018).

## Alternatives considered

- **Status quo** — keep the redundant blob. Rejected: ~40% of the DB is a growing duplicate.
- **(D) Capture everything losslessly into Postgres, drop the blob.** Rejected: re-materializes the same
  multi-hundred-MB tool-result mass inside Postgres (little net reclaim), commits us to a lossless-parse
  contract forever, and forecloses re-deriving new structure later — you can only query what you thought
  to capture at parse time.
- **(A) Externalize the parsed jsonb blob to object storage.** Archives a re-serialized intermediate
  rather than the true original, and keeps the "blob" abstraction alive. The chosen decision is A refined
  to archive the _raw file_ and parse from it.
- **`pg_largeobject` (blob stays in Postgres).** Keeps full transactional guarantees and the identical
  backup story (an upload can't partially succeed; a delete rolls back on abort). Rejected as primary:
  blobs still consume the Postgres backup set (the bloat we are removing), get no independent
  HTTP-accessible URL (wanted for future cockpit direct-streaming), and cannot carry a separate
  retention/lifecycle policy (delete a session's raw without a PG migration). For a cold, immutable,
  large-object workload these ~~three~~ **two** tip to object storage. **⚠ The third leg does not hold on Supabase:
  Supabase Storage does not support S3 lifecycle configuration either, so a retention policy is
  application code under both options — corrected 2026-08-18, see `## Corrections`.**
- **(C) Accept lossy reconstruction from per-turn rows, fall back to JSONL.** Rejected: spike fact (1) —
  no JSONL fallback for most rows; spike fact (2) — the rows are lossy.

## Consequences

**Easier / reclaimed:**

- Postgres sheds most of ~623 MB (~40%) and stops carrying an unbounded raw blob; the index tracks only
  what we query and stays lean. Reclaim math: object storage ~$0.021/GB/mo vs Postgres ~$0.125/GB/mo — the
  reclaim is real, the archive cost negligible.
- Full original fidelity is preserved **and** re-derivable: any future question — new structured field,
  replay, re-embed at a different granularity — is a re-parse from the archive, with no "we should have
  captured that." This is the property (D) and (C) cannot give.
- Two durable copies, cleanly split: the archive holds the raw (system of record); Postgres holds the
  derived index (rebuildable, disposable). The redundant _third_ copy — today's in-PG raw blob duplicating
  the per-turn rows — is what goes away.
- The runtime never touches ephemeral local disk; answerability no longer depends on JSONL retention.

**Harder / newly committed:**

- **Object storage becomes an operational surface** — retention, access-control, backup, lifecycle.
  Mitigated by staying within Supabase (same vendor/auth/backup already in the stack), but the runtime
  read paths must handle archive-fetch failure.
- **Security / access-control (required).** Transcripts may contain secrets, tokens, and PII. The archive
  bucket MUST be **private** — no public URLs; access via the service key or short-lived signed URLs only.
  The cockpit server and any archive reader must hold the right Supabase credentials. This must be settled
  before the first upload.
- **Disaster recovery (required to state).** For the ~60% of sessions with no local JSONL, the archive is
  the _only_ copy — accidental bucket deletion is permanent data loss. **Supabase database backups do NOT
  cover Storage object contents** — they cover only the `storage.objects` metadata rows, so the bucket is
  a critical asset that the project backup does **not** protect. Verified against
  [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups); see
  `docs/architecture/transcript-archive.md §Backup / disaster-recovery posture`. The outstanding
  mitigation is an off-Supabase mirror — **mt#2715**, still TODO, and a candidate gate on the mt#2580
  column drop. This paragraph originally asserted the opposite; see `## Corrections` (2026-08-18).
- **Ingest must be fail-safe upload-then-parse:** never parse-and-discard when the upload has not durably
  confirmed. Archive objects are immutable and content-addressed/versioned per `(agentSessionId, harness)`;
  re-ingest / HWM-regression must be idempotent (the modern COALESCE-append can duplicate lines when the
  HWM read fails, `agent-transcript-ingest-service.ts:65-69` — the archive write must not inherit that).
- **Existing-row backfill is a hard precondition to the drop, and is schema-aware.** For rows whose only
  surviving copy is today's PG blob, upload that blob into the archive **before** dropping the column; no
  row is dropped ahead of a confirmed archive object. Legacy rows (`harness='legacy'`) hold a _pre-extracted_
  `TranscriptMessage[]`, not raw JSONL — archiving one does **not** yield a raw original. The migration must
  `SELECT count(*) ... WHERE harness='legacy'`, choose one handling — skip (no archive; documented as
  permanently-lossy), archive-as-is with a `format=legacy-transcript-message` marker, or treat the per-turn
  rows as the definitive reconstruction — and encode it in the migration script. This is a one-time
  reconciliation gated on a verified count.
- **The six readers must be re-pointed** off the blob before the drop: reader (6) (context-inspector) to
  the promoted PG columns; the derive/summary/metadata readers to the archive-on-parse or the derived rows;
  `getTranscript` to the derived rows (or archive on demand for genuine full-fidelity callers).
- **`agent_transcript_turns` gains a conceptual writer coupling** (the promoted thinking/metadata columns
  are written on the same extraction path as the text columns; the mt#1418 single-writer guard remains the
  soft prerequisite, per ADR-019).

## Promoted-column register

`## Decision` says the derived index carries "a small set of currently-dropped fields promoted to
columns," and mt#2580 §1 owns fixing that set. Promotions have been landing one task at a time
ahead of that audit, each recording itself only in its own task spec — so the SET existed but the
LIST did not, and nothing in the repo said which columns were promoted under this ADR or why. This
table is that list. **A promotion is not complete until it appears here.**

| column                     | task    | landed     | why it qualifies under `## Decision`                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `user_origin` (text, null) | mt#4289 | 2026-08-19 | Who authored the turn's `user_text` — `human` vs a harness kind. Inside the "fields the context-inspector consumes" set by that clause's own criterion: `session-context-snapshot.ts` already reads `isCompactSummary`, one of the four raw fields it derives from. Measured 2026-08-19: 43.5% of rows carrying `user_text` are harness-written, so without it every `type: "user"` consumer reads them as the operator. |

Registered but not yet landed: per-turn `usage` + `model` (mt#3383 §3), tool-call / tool-result
columns (mt#2583). mt#2580 §1's audit consumes this table rather than re-deriving it.

**Two properties every row here must hold**, both of which follow from `## Decision` rather than
from convention:

1. **Derived at PARSE time, never read from the blob.** That is what makes the column reproducible
   by re-parse and keeps it from adding a reader this ADR's endgame has to re-point (mt#2580 §2).
2. **Backfilled by re-parse, not by a bespoke script.** `extractTurnsForAllTranscripts` is already
   the keyset-paginated resumable sweep, and any column in the upsert's on-conflict SET is filled by
   a re-run. Two consequences worth stating because both have already caught someone:
   - A skip-if-unchanged guard on that upsert must list every promoted column, or the sweep skips
     unchanged rows and populates nothing — silently, still reporting success (mt#4345).
   - Running the sweep corpus-wide is a bulk shared-state operation, not a step inside a feature
     PR: ~327k rows at ~9.5–17.5s per 100-row chunk (mem#950). mt#4050 owns the authorized run.

## Cross-references

- **Supersedes the draft ADR-019 proposal's stage-1 landing zone** (ADR-019 is Proposed, not Accepted;
  raw moves from the PG `transcript` JSONB to the object-store archive, and extraction parses from the
  archived raw). **Related ADRs:** ADR-017 (transcript capture triggers — the watch/sweep that becomes
  upload-then-parse), ADR-018 (canonical persistence pattern + require-Postgres), ADR-013 (filtered vector
  search — the derived semantic index), ADR-002 (persistence-provider architecture).
- **Related tasks:** mt#2581 (umbrella), mt#2580 (drop the blob — post-backfill), mt#2582 (this ADR),
  mt#2583 (surface-fields-in-PG, narrowed — coordinates with the promoted-column set here), mt#2584 (the
  spike — evidence base), mt#2585 (embedding granularity), mt#2234 (capture entry points that become
  upload-then-parse). (mt#2331 `TranscriptSearchRepository` is adjacent — it abstracts the search/similarity
  services — but is **not** a prerequisite for this blob-storage change.)
- **Memory:** `df19d9e1` (Postgres-via-Supabase default + the four-criteria second-store bar this ADR
  clears), `70b595dc` (search index is derived data), `115c8a59` (require-Postgres / single-store).
- **Decision record:** ask `8bec2e60` (the principal decision this ADR formalizes). Independent advisor
  critique (2026-07-01) informed the context-inspector-latency, policy-framing, and legacy-format
  corrections. Status flipped Proposed → Accepted on 2026-07-08; the recorded decision was
  principal-confirmed 2026-07-01.
- **Origin:** 2026-06-30 transcript-size investigation + mt#2584 spike; principal direction 2026-07-01.
