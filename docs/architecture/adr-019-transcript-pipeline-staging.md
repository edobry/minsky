# ADR-019: Transcript Pipeline Staging — Extract-on-Capture, Embed-Deferred

## Status

Proposed

## Context

The transcript substrate (`agent_transcripts` / `agent_transcript_turns`, the surface behind
`transcripts_search` and `transcripts_search-text`) is produced by a pipeline with three
conceptually-distinct operations. ADR-017 decided **what triggers** that pipeline
(continuous-JSONL watch/sweep over exit-hook reliance). This ADR decides **where the internal
seam between the pipeline's stages sits** — an orthogonal axis ADR-017 left open.

The three operations, and their very different cost / dependency profiles:

| #   | Operation   | Reads → writes                                                 | Cost                 | External dependency | Feeds                               |
| --- | ----------- | -------------------------------------------------------------- | -------------------- | ------------------- | ----------------------------------- |
| 1   | **Ingest**  | JSONL → `agent_transcripts.transcript` (JSONB)                 | cheap                | none                | (nothing searchable yet)            |
| 2   | **Extract** | JSONB → `agent_transcript_turns` rows + `fts_text` (GENERATED) | cheap, deterministic | **none**            | **FTS** (`transcripts_search-text`) |
| 3   | **Embed**   | turn text → vector → `agent_transcript_turns.embedding`        | expensive            | **embedding API**   | **semantic** (`transcripts_search`) |

**Where the seam sits today.** The code cuts between **(1)** and **(2+3)**: `transcripts ingest`
(`AgentTranscriptIngestService`) writes only the raw JSONB at stage 1, and
`PerTurnEmbeddingPipeline` (`packages/domain/src/transcripts/per-turn-embedding-pipeline.ts`) is
the **sole writer of `agent_transcript_turns`** — it performs extraction (2) **and** embedding (3)
in one pass, invoked only by `transcripts index-embeddings`.

**Why that seam is in the wrong place.** Extraction (2) is what FTS needs, and it is cheap,
deterministic, and API-free — it has the same profile as ingest (1), not as embedding (3). By
fusing extraction into the embedding pipeline, FTS inherits a dependency on the embedding API
that it does not need. The observable consequences:

- A plain `transcripts ingest` makes a session searchable by **neither** tool — the turn rows
  (and their `fts_text`) don't exist until `index-embeddings` runs.
- FTS — a keyword search with no semantic component — cannot work until an embedding-API-dependent
  stage has run. If the embedding provider is unconfigured, rate-limited, or down, FTS over freshly
  captured sessions is dark.
- The `agent_transcripts` table can be fully current while `agent_transcript_turns` lags by days
  (observed 2026-06-08: parent table current to that day, turns frozen ~18 days earlier because
  `index-embeddings` had not run). This is the symptom that surfaced during mt#2319.

**Why it ended up this way: accretion, not design.** The lineage (inferred from task references in
the code) is that ingest landed first (mt#1313 / mt#1324, raw capture) and per-turn embeddings were
added later as a layer (mt#1352). Because you must have turns extracted _before_ you can embed them,
extraction was materialized _inside_ the embedding pipeline as a convenient prerequisite — rather
than being placed with ingest, where its cost profile says it belongs.

**The schema already anticipates the split.** `agent_transcript_turns.embedding` is **nullable**, and
the semantic search path already guards on `embedding IS NOT NULL`. So "a turn row that exists but is
not yet embedded" is an **already-supported, already-handled state**. Re-cutting the seam therefore
requires **no schema migration** — only a pipeline-wiring change.

## Decision

We will re-cut the pipeline seam from **(1) | (2+3)** to **(1+2) | (3)**:

- **Extraction rides with capture.** The capture entry point (`transcripts ingest`, reached by the
  watcher, the sweep, the SessionEnd fast-path, and the MCP boot sweep) materializes per-turn rows in
  `agent_transcript_turns` (with `fts_text` auto-generated). A captured session is therefore
  **FTS-searchable immediately, with no embedding API call**.
- **Embedding stays the only deferred, API-dependent stage.** A separate backfill fills
  `agent_transcript_turns.embedding` for rows that already exist — idempotent and resumable, run off
  the capture critical path (in the daemon's post-ingest step and/or the sweep, per mt#2234 / ADR-017).
  This is unchanged in spirit from today: keeping the expensive, provider-dependent step off the hot
  path is exactly why mt#2192 gated embeddings behind an opt-in env var. **Only extraction moves; the
  decision to defer embedding is preserved.**

Concretely, `PerTurnEmbeddingPipeline`'s turn-materialization responsibility moves to the capture
path; what remains of the embedding work becomes a vector-fill over existing rows. The split is owned
and implemented by **mt#2234** (the cockpit-daemon capture task), which already owns the capture
entry points and the embedding backfill.

We explicitly reject two alternatives:

- **Embed during ingest (fuse all three stages onto the hot path).** Rejected: this couples capture
  reliability to the embedding API — the opposite of ADR-017's reliability goal — and would make every
  watcher append / boot sweep wait on a rate-limited external call.
- **Leave the seam as-is and rely on the backfill being prompt (ADR-017's watcher).** Rejected as the
  _primary_ answer: the watcher does make turns fresh, but it does so by running the API-dependent stage,
  so FTS remains needlessly gated on the embedding provider. The watcher and the seam re-cut are
  complementary — the watcher makes capture _prompt_; the seam re-cut makes FTS _API-independent_.

## Consequences

**Easier:**

- FTS over freshly captured sessions works with no embedding provider configured, and never goes dark
  when the provider is rate-limited or down. The mt#2192-era claim "FTS works after ingest, no external
  API" becomes true-by-construction (see mt#2333 for the doc correction that this supersedes).
- Latency/reliability of the two search modes are decoupled at the data layer: keyword search tracks
  capture; semantic search tracks the embedding backfill. The mt#2319 coverage signal already reports
  the gap between them.
- No migration: the change is pipeline wiring against an already-permissive schema.

**Harder / newly committed:**

- `agent_transcript_turns` now has two writers conceptually (extraction at capture; embedding at
  backfill) operating on the same rows. They must compose: extraction inserts/updates text columns;
  the backfill updates only the `embedding` column on existing rows (per-`turn_index` upsert, never
  re-deriving text). The single-writer concurrency guard (mt#1418) remains the soft prerequisite for
  overlapping capture + backfill.
- The backfill must select rows where `embedding IS NULL` (or stale) rather than re-extracting from
  JSONB, so it does not redundantly re-materialize turns.
- Extraction now runs on the capture hot path. It is cheap (deterministic JSONL→rows), but the capture
  path's cost rises from "write one JSONB blob" to "write the blob + N turn rows." This is acceptable
  and intended — it is the cost of FTS-on-capture — but it makes capture marginally heavier than the
  pre-split ingest.

## Implementation notes (mt#2381)

The seam split shipped in mt#2381 (PR #1640):

- **Extraction half — `turn-writer.ts`.** `writeTurnsForTranscript(db, sessionId, transcript)` extracts
  turns (reusing `extractTurns`) and upserts text/metadata columns ONLY — `embedding` is omitted from
  both the insert values and the `ON CONFLICT … SET`, enforcing the embedding-preservation invariant.
  `extractTurnsForAllTranscripts(db)` is the historical reconciliation. The ingest service calls
  `writeTurnsForTranscript` on the capture path (over the full merged transcript).
- **Embedding half — `PerTurnEmbeddingPipeline` is now vector-only.** Its `PipelineRunResult` fields
  changed from transcript-centric (`transcriptsScanned/Processed/Skipped/Errored`, `turnsWritten`) to
  turn-centric: `turnsScanned`, `turnsEmbedded`, `turnsErrored`, `embeddingCallsMade` (now counted **per
  batch** — one `generateEmbeddings` invocation — not per turn). `run()` takes an optional
  `{ agentSessionId }` scope.
- **`transcripts.index-embeddings` command** runs three stages: extraction reconciliation → vector-only
  embedding → summary; its result shape gained an `extraction` field alongside `perTurn` / `summary`.
- **`tool_calls` encoding fix.** Pre-mt#2381 the combined pipeline wrote `JSON.stringify(toolCalls)` into
  the `jsonb` column, double-encoding every row (`jsonb_typeof = 'string'`), which silently broke
  `Array.isArray(tool_calls)` consumers (`agent-spawns-pipeline.findAgentToolCall`). turn-writer passes
  the array directly (`jsonb_typeof = 'array'`); `extractTurnsForAllTranscripts` corrects existing
  double-encoded rows on the next `index-embeddings --all`.

## Implementation notes (mt#2457)

The extraction-on-capture path (mt#2381) fixed the FORWARD path, but the HWM-gated capture
mechanisms never re-extract already-ingested sessions — so the ~651 sessions ingested in the
window before mt#2381 shipped stayed turn-less until this task's backfill ran. mt#2457 also
closed a silent-failure gap in the reconciliation primitive itself and made it safe to run over
the full corpus:

- **`writeTurnsForTranscript` return shape.** Changed from a bare `Promise<number>` to
  `Promise<WriteTurnsResult>` — `{ written, nonEmptyYieldedZero, erroredChunks }`:
  - `nonEmptyYieldedZero: boolean` — true when the input transcript was a real, non-empty array
    but `extractTurns` returned zero turns (an extractor-shape mismatch), as opposed to a
    genuinely empty/absent transcript. This case now also WARN-logs
    (`writeTurnsForTranscript: non-empty transcript … yielded zero turns …`) instead of returning
    a bare `0` indistinguishable from "nothing to do."
  - `erroredChunks: number` — count of failed bulk-insert chunks (see below); non-zero means
    `written` under-counts `extractTurns(transcript).length` due to a write failure, not a
    genuinely-empty result.
- **Bulk-upsert instead of per-turn inserts.** The original per-turn loop issued one awaited
  `INSERT … ON CONFLICT` per turn — for a handful of legacy sessions with thousands of turns (up
  to ~4,511 raw lines observed in the 2026-07-20 corpus measurement), that meant thousands of
  serial round-trips to a remote Postgres, which alone consumed a full session_exec time budget
  processing a SINGLE session. `writeTurnsForTranscript` now chunks turns into groups of 500 and
  issues one multi-row `INSERT … ON CONFLICT` per chunk, preserving the exact same
  idempotent/embedding-preservation semantics. A chunk that fails to upsert increments
  `erroredChunks` and is WARN-logged rather than silently dropped.
- **`extractTurnsForAllTranscripts` — batched/bounded/resumable.** The prior implementation loaded
  ALL `agent_transcripts` rows in one unbounded `SELECT` before iterating — over ~1,584 large-JSONB
  rows this did not complete in 280s locally. It now pages through the corpus via keyset
  pagination (`fetchTranscriptPage`, ordered by `agent_session_id`, the table's primary key — no
  new index needed), with `ExtractAllTurnsOptions.batchSize` / `afterId` (resume from a checkpoint)
  / `onBatchComplete` (a callback a caller can use to persist a resume checkpoint after each page).
  `fetchTranscriptPage` executes (awaits) the query explicitly rather than returning the drizzle
  query builder for the caller to implicitly unwrap via `await`.
- **`ExtractAllTurnsResult` gained two fields:**
  - `nonEmptyYieldedZero: number` — count of transcripts hitting the loud-failure case above (a
    subset of `transcriptsSkipped` when there is no chunk error; if a chunk error ALSO occurred,
    the transcript counts under `transcriptsErrored` instead, per the classification below).
  - `aborted: boolean` — true when the sweep stopped early because a `fetchPage` call itself
    failed (as opposed to reaching a clean end-of-corpus empty page). Before this field existed,
    a fetch failure was logged but invisible in the returned result — a caller reading only the
    counts could not tell "finished cleanly" from "gave up partway through."
- **Per-transcript classification** (mirrored identically in `extractTurnsForAllTranscripts`'s
  sweep loop and the `transcripts.index-embeddings --conversationId=<uuid>` single-session path):
  `erroredChunks > 0` → `transcriptsErrored` (even if `written > 0` from a partial success — a
  degraded result is not "processed"); else `written === 0` → `transcriptsSkipped` (+
  `nonEmptyYieldedZero` if that also applied); else → `transcriptsProcessed`.
- **Backfill runner — `scripts/backfill-agent-transcript-turns.ts`.** The task-wrapped, dry-run-first
  driver for this reconciliation (`operational-safety-dry-run-first.mdc`): default invocation counts
  zero-turn non-null-transcript rows and compares against the ~651 baseline measured 2026-07-20,
  STOPping (exit 1, no write) if the count diverges beyond ~2x — the dry-run scope-match gate.
  `--execute` drives `extractTurnsForAllTranscripts` with per-batch progress logging;
  `--after-id=<uuid>` resumes an interrupted run from a checkpoint; `--batch-size=<n>` overrides
  the page size. The corpus was fully reconciled via this runner (resumed across several
  invocations for the largest legacy sessions); zero-turn non-null-transcript rows in the
  2026-04-27 – 2026-06-08 window went from 650 to 0.

## Cross-references

- Related tasks: **mt#2234** (cockpit-daemon transcript capture — owns and implements this split),
  mt#2319 (transcript search correctness — DONE; the investigation that surfaced the misplaced seam),
  mt#2333 (CLAUDE.md mt#2192-doc correction — the interim fix this ADR makes structural),
  mt#2192 (SessionEnd fast-path; gated embeddings behind an opt-in env var — the deferral this ADR
  preserves), mt#1352 (per-turn embeddings — introduced `PerTurnEmbeddingPipeline`, the fused stage
  being split), mt#1313 / mt#1324 (transcripts substrate), mt#1418 (ingest concurrency guard — soft
  prerequisite), mt#2051 (MCP boot sweep — a capture entry point), **mt#2457** (backfill for the
  ~651 legacy sessions the mt#2381 split never re-extracted, + the loud-failure/batching fixes
  documented above).
- Related ADRs: **ADR-017** (transcript capture — continuous-JSONL watch/sweep; decides _what triggers_
  the pipeline, the orthogonal axis to this ADR's _internal seam_); ADR-013 (filtered vector search —
  the semantic-search read path that already guards on `embedding IS NOT NULL`); ADR-002
  (persistence-provider architecture).
- Code: `packages/domain/src/transcripts/per-turn-embedding-pipeline.ts` (sole writer of
  `agent_transcript_turns`, to be split); `agent-transcript-ingest-service.ts` (the capture entry point
  extraction moves onto); `transcript-fts-service.ts` / `transcript-similarity-service.ts` (the read
  paths); `agent-transcript-turns-schema.ts` (`fts_text` GENERATED, nullable `embedding`).
- Memory: `10690591-10f9-448b-a9b7-f78e6e8e969c` (the two-stage-pipeline investigation).
- Origin: 2026-06-08 mt#2319 close-out — Socratic review of why "FTS works after ingest" was false.
