import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects-schema";

/**
 * Guard/calibration event corpus — ONE append-only table for every stream the
 * hook and calibration substrate writes (mt#4034, mt#3334 phase 2).
 *
 * The stream set is the phase-1 inventory
 * (`docs/architecture/guard-calibration-stream-inventory.md`): 28 calibration
 * fire logs, 5+ evaluation streams, the fire-log (427k+ lines), the
 * guard-health log, hook-outcome streams, `subagent-model-mismatch`,
 * `two-strikes/observations.jsonl`, `conversation-transitions`, and the
 * JSON-array-formatted `mcp-disconnect-log`. Heterogeneous shapes, one table.
 *
 * ## Table-shape decision (mt#4034 SC1)
 *
 * **Chosen: one events table with a `stream` discriminator, a small promoted
 * column set for the known read shapes, and the verbatim record in `payload`
 * jsonb. Rejected: per-family tables** (calibration_events / evaluation_events
 * / fire_log_events / ...). Rationale:
 *
 * - **The stream set is open-ended and grows without ceremony.** Two new
 *   streams appeared DURING the phase-1 inventory itself (mt#3918's detector
 *   fired live mid-session), and another detector was in flight at planning
 *   time (mt#3658 / PR #2909). ADR-028's registry-derived calibration
 *   architecture deliberately lets a new guard declare its log with no
 *   hand-registration; a table-per-family schema would reintroduce exactly
 *   that ceremony as a migration per new shape. Here a new stream is DML,
 *   never DDL.
 * - **41 heterogeneous shapes flatten lossily.** Typed per-family columns
 *   either multiply tables or drop detector-specific fields — and dropped
 *   fields are how calibration evidence gets lost (mem#827: a detector was
 *   dispositioned "unclassifiable" while its measurements sat in the fields a
 *   parse had set aside). `payload` keeps every record byte-equivalent in
 *   content; promoted columns are conveniences, never the storage.
 * - **Every known read shape is served by the promoted set** (see the index
 *   mapping below). Cross-family catalog queries (mt#4009) read one surface
 *   instead of UNIONs over N tables.
 * - **Sibling counterpoint:** `guard_canary_runs` (mt#4007) IS a dedicated
 *   typed table — because its shape is closed and known. This corpus is the
 *   opposite (open, heterogeneous), which is why it gets the opposite shape.
 *
 * ## Data-engineering-lens answers (mt#4034 SC1)
 *
 * - **System of record: the on-disk JSONL spool — de facto, pending mt#3761.**
 *   The thin-hooks RFC (Accepted 2026-08-11, mem#960) keeps per-invocation
 *   dispatcher guards DB-blind (live connect 3.3–5.5s vs a sub-second hook
 *   budget), so hooks write JSONL and ingest copies. This table is a
 *   REBUILDABLE DERIVED copy — the same posture ADR-025 records for
 *   transcripts (raw source elsewhere, Postgres as rebuildable derived
 *   index). Whether the DB should BECOME system of record is mt#3761's ADR;
 *   nothing here preempts it.
 * - **Rebuildability / idempotency: `dedupe_key`.** sha256 hex over
 *   `<stream>\n<verbatim JSONL line>`. The key is a pure function of stream
 *   identity + record bytes — independent of file path, line number, ingest
 *   time, and machine — so re-reading the same span from a moved, rotated, or
 *   re-listed file maps every line to the same key, and the PLAIN unique
 *   index makes the re-insert a no-op via `ON CONFLICT DO NOTHING`. Plain,
 *   not partial: a bare `ON CONFLICT (dedupe_key)` target can only infer a
 *   plain unique index as its arbiter (mem#659 — partial-index inference
 *   broke short_id inserts in production, 2026-07-21). Residual collapse
 *   case, accepted: two byte-identical lines in one stream collapse to one
 *   row. Every inventoried stream carries record-level timestamps (verified
 *   at design time, including `two-strikes/observations.jsonl`'s
 *   firstAt/secondAt), so byte-identical DISTINCT events are not expected;
 *   collapsing a pathological duplicate append is acceptable for this
 *   corpus. For the one non-JSONL source (`mcp-disconnect-log.json`, a
 *   whole-file JSON array) the hash input is the canonical JSON serialization
 *   of the array element; phase 3 (mt#4035) owns that canonicalization.
 * - **Insert-only.** No updates, no upserts-that-rewrite — the
 *   read-modify-write pattern on TOASTed columns is the write-amplification
 *   pathology mem#773 measured on `agent_transcripts` (~69 rewrites/row).
 *   Ingest appends; `ON CONFLICT DO NOTHING` is the only conflict behavior.
 *
 * ## Index set — justified by the known read shapes (mt#4034 SC4)
 *
 * Mapping to mt#4009 SC1's catalog aggregations (and mt#4009 AT1, "denials
 * per guard per week"), rationalization-review's fire-log reads, and the
 * per-project calibration consumer (mt#3518 / mem#802):
 *
 * - `(guard_name, occurred_at)` — fire counts by decision per guard per
 *   window (AT1: `WHERE guard_name = ? AND occurred_at >= ?` then filter the
 *   promoted `decision`); duration/cost aggregates over promoted
 *   `duration_ms` (latency percentiles); last-fire time (`max(occurred_at)`
 *   per guard); guard-health liveness reads (one stream, same key). Override
 *   usage reads the same per-guard windows; override fields stay in
 *   `payload` and classify in memory (one window scan, no N+1 — the
 *   rationalization-review already reads this way). A `(guard_name,
 *   decision, occurred_at)` composite is deliberately deferred until a
 *   measured need: per-guard weekly row counts are modest, and query tuning
 *   on this family has its own track (mt#4019 precedent).
 * - `(stream, occurred_at)` — per-stream rollups, calibration-state windows
 *   (registry metadata joins in from code, not from this table), evaluation
 *   miss-rate denominators.
 * - `(project_id, occurred_at)` — the second consumer: per-project
 *   calibration-signal aggregation (mem#802 "customers emit signal, the
 *   system/vendor tunes"). `project_id` is nullable and stamped AT INGEST
 *   from the record's cwd/session project, per the `resolveRunStateProjectId`
 *   precedent (`docs/architecture/evaluation-loop-fire-log.md §Tuning
 *   ownership and project scoping`) — never by the writers (mt#3518: on-disk
 *   formats unchanged).
 * - `uq_guard_events_dedupe_key` — the rebuild/idempotency arbiter (above).
 *
 * ## What deliberately rides in `payload` (mt#4034 SC3)
 *
 * The calibration family's matched/injected/evaluation-only distinctions,
 * override/dismissal markers (`overrideEnvVar` / `overrideClassification` /
 * `overrideSource` / `overrideGrantAsk`, `logged_only`, per-detector
 * `matches`/`claims`/`targets`), and ADR-032 D2's per-fire labeled-response
 * field (`ObservationResponse: heeded | dismissed | unknown` — its emitter is
 * ADR-032's first piece of work) all arrive as record fields and are
 * preserved verbatim. A future promoted column for any of them is additive
 * DDL over data that is already here; nothing is flattened away.
 *
 * - **`family` is text, not a pg enum** — a new family must not require a
 *   migration; the inventory doc and phase-3 ingest config own the
 *   vocabulary (calibration / evaluation / fire-log / guard-health /
 *   hook-outcome / special).
 * - **`occurred_at` is nullable** — it is the record's OWN timestamp; a
 *   timestamp-less record ingests honestly as null rather than with a
 *   fabricated time. `ingested_at` (not null) orders those.
 * - **Invocation path (by design, none in this PR):** nothing writes this
 *   table until phase 3 (mt#4035: SessionEnd push + daemon sweep +
 *   task-wrapped backfill) and nothing reads it until mt#4009 — that is
 *   mt#3334's phase decomposition, not missed wiring.
 *
 * @see mt#4034 — this table (mt#3334 phase 2)
 * @see docs/architecture/guard-calibration-stream-inventory.md — the stream set (mt#4033)
 * @see docs/architecture/evaluation-loop-fire-log.md — fire-log record shape + project scoping
 * @see docs/architecture/adr-027-postgres-only-persistence-confirmed.md — substrate
 * @see docs/architecture/adr-025-transcript-storage-object-store-system-of-record.md — the rebuildable-derived-index posture this extends
 * @see docs/architecture/adr-032-guard-threshold-tuning-loop.md — D2 labeled-response fields (ride in payload)
 * @see packages/domain/src/storage/schemas/guard-canary-runs-schema.ts — closed-shape sibling
 * @see mt#3761 — the system-of-record ADR this table's posture defers to
 * @see mt#4035 — phase-3 ingest (the writer); mt#4009 — the aggregation reader
 */
export const guardEventsTable = pgTable(
  "guard_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Inventory stream name — §A stems ("wall-of-text"), state-dir names ("fire-log"). */
    stream: text("stream").notNull(),

    /** Inventory section family: calibration | evaluation | fire-log | guard-health | hook-outcome | special. Text, not enum — see doc comment. */
    family: text("family").notNull(),

    /** Guard identity where the record carries or implies one (fire-log/guard-health `guardName`; calibration streams via the registry's stream→guard mapping at ingest). Null for non-guard streams. */
    guardName: text("guard_name"),

    /** Conversation id as recorded by the writer (`session_id` / `sessionId`), verbatim. */
    sessionId: text("session_id"),

    /** Stamped at ingest from the record's cwd/session project — never by writers (mt#3518). SET NULL on project deletion: events are append-only and outlive their project linkage (PR #2912 R1). */
    projectId: uuid("project_id").references(() => projectsTable.id, { onDelete: "set null" }),

    /** The record's OWN timestamp. Nullable — see doc comment. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),

    /** Fire-log tri-state: allow | warn | deny. Null outside the fire-log family. */
    decision: text("decision"),

    /** Lifecycle event / event kind where the record carries one (fire-log `event`, guard-health `event`). */
    event: text("event"),

    /** Per-fire evaluation cost (fire-log `durationMs`). */
    durationMs: integer("duration_ms"),

    /** The verbatim parsed record. Content-complete — promoted columns are conveniences. */
    payload: jsonb("payload").notNull(),

    /** sha256 hex over `<stream>\n<verbatim JSONL line>` (canonical element serialization for non-JSONL sources) — the rebuild/idempotency key (see doc comment). */
    dedupeKey: text("dedupe_key").notNull(),

    /** Originating file path at ingest time (provenance for rebuild audits; per-machine paths vary). */
    sourcePath: text("source_path"),

    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Rebuild/idempotency arbiter — PLAIN unique (mem#659: partial indexes are
    // not inferable by a bare ON CONFLICT (dedupe_key) target).
    uniqueIndex("uq_guard_events_dedupe_key").on(table.dedupeKey),
    // Per-guard windows: counts by decision, duration aggregates, last-fire.
    index("idx_guard_events_guard_name_occurred_at").on(table.guardName, table.occurredAt),
    // Per-stream windows: rollups, calibration state, evaluation denominators.
    index("idx_guard_events_stream_occurred_at").on(table.stream, table.occurredAt),
    // Per-project calibration-signal aggregation (mt#3518 / mem#802).
    index("idx_guard_events_project_id_occurred_at").on(table.projectId, table.occurredAt),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type GuardEventRecord = typeof guardEventsTable.$inferSelect;
export type GuardEventInsert = typeof guardEventsTable.$inferInsert;

// ---------------------------------------------------------------------------
// Fire-log lifetime rollup (mt#4294)
// ---------------------------------------------------------------------------

/**
 * Per-guard LIFETIME totals over the `fire-log` stream, maintained
 * incrementally so no reader ever aggregates `guard_events` in full.
 *
 * ## Why this table exists
 *
 * The lifetime figures the interceptor catalog renders used to come from a
 * `GROUP BY guard_name` over the whole table. Measured 2026-08-19 at 724,780
 * rows / 677 MB: **2,193 ms and ~404 MB of disk reads per refresh, per
 * cockpit**, to produce 109 rows — and the equivalent SINGLE-guard query was
 * WORSE (10,972 ms), because filtering by `guard_name` turns a sequential scan
 * into a bitmap heap scan over ~37,688 scattered blocks.
 *
 * ## Why a maintained table and not an index or a view
 *
 * Both alternatives were measured and rejected (mt#4294 records the plans):
 *
 * - **A covering index** does not help. An index-only scan over this table
 *   measured 9,474 ms — 4.3x SLOWER than the sequential scan — because ~68K
 *   rows/day arrive continuously, so the newest rows are never marked
 *   all-visible and each one costs a random heap fetch. On an append-only
 *   table that condition is the steady state, not a stale-statistics artifact
 *   a VACUUM clears.
 * - **A materialized view** relocates the cost rather than removing it:
 *   `REFRESH` re-runs the full query every time, and `CONCURRENTLY` is slower
 *   still. Postgres has no built-in incremental refresh.
 *
 * What remains is the documented alternative for an append-mostly event table:
 * an incremental rollup maintained by upsert, processing only rows new since
 * the last pass.
 *
 * ## Why it cannot drift
 *
 * `buildInsertBatch` (`guard-events/ingest-runtime.ts`) is the SOLE writer of
 * `guard_events` — verified by grep across `src`, `packages`, `scripts` and
 * `tests`. It inserts with `ON CONFLICT (dedupe_key) DO NOTHING ... RETURNING`,
 * so the rows it returns are exactly the rows that were actually appended:
 * re-ingesting the same file folds in nothing, which is what makes this exact
 * rather than approximately-right. There is no watermark and no time-based
 * cursor, so there is no late-commit window to reason about.
 *
 * `rebuildFireLogLifetimeRollup` recomputes the whole table from
 * `guard_events` for bootstrap and for self-heal; `scripts/verify-interceptor-aggregates.ts`
 * cross-checks the maintained values against a direct recompute.
 *
 * ## Grain
 *
 * One row per `guard_name` observed on the `fire-log` stream. Deliberately NOT
 * keyed by stream: `guard_events.guard_name` carries two name-spaces (mt#4068
 * — calibration rows use `stream-sources.ts` labels, fire-log rows use registry
 * names), so a cross-stream rollup on this key would conflate them. Scoping to
 * the fire-log stream is what keeps the key meaningful.
 */
export const guardEventFireLogRollupTable = pgTable("guard_event_fire_log_rollup", {
  /** Registry guard name, as it appears on `fire-log` rows. */
  guardName: text("guard_name").primaryKey(),

  /** All-time fire count for this guard. Counts rows, including any whose `occurred_at` is null. */
  totalFires: integer("total_fires").notNull().default(0),

  /** Earliest non-null `occurred_at`. Null when every row for this guard lacks one. */
  firstFireAt: timestamp("first_fire_at", { withTimezone: true }),

  /** Latest non-null `occurred_at`. Null when every row for this guard lacks one. */
  lastFireAt: timestamp("last_fire_at", { withTimezone: true }),

  /** Last time this row was folded into or rebuilt. Diagnostic, not a cursor. */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuardEventFireLogRollupRecord = typeof guardEventFireLogRollupTable.$inferSelect;
export type GuardEventFireLogRollupInsert = typeof guardEventFireLogRollupTable.$inferInsert;
