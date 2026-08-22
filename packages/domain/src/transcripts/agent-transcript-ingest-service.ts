/**
 * AgentTranscriptIngestService
 *
 * Orchestration layer that wires a TranscriptSource adapter to the
 * `agent_transcripts` DB table.  Per-session ingest is incremental: only JSONL
 * lines whose timestamp is strictly greater than the stored
 * `last_ingested_jsonl_timestamp` high-water-mark are ingested.  Re-running
 * over an unchanged JSONL is a no-op.
 *
 * ## Credential scrubbing (mt#2763)
 *
 * Every raw line is passed through `scrubValueDeep` (see
 * `./credential-scrubber.ts`) BEFORE it reaches either durable-copy
 * destination this service writes to — `agent_transcripts.transcript` JSONB
 * and `agent_transcript_attachments.content`. This is the chosen enforcement
 * point: investigation (documented in `credential-scrubber.ts`'s header)
 * found that a Claude Code PostToolUse hook cannot rewrite/redact a tool
 * result before it is stored or displayed, so the scrub cannot happen at the
 * hook layer — it has to happen here, at ingest, the first point a raw line
 * is about to become a DB-backed durable copy. Per-turn extraction
 * (`turn-writer.ts`) re-reads the already-scrubbed stored transcript, so one
 * interception point covers every DB-backed read path. This does NOT scrub
 * the harness's own on-disk JSONL copy or the live model context — see
 * `credential-scrubber.ts`'s "What this does NOT cover" section.
 *
 * @see mt#1313 §Ingestion semantics
 * @see mt#1351 — this file
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource
 * @see mt#1324 — agent_transcripts schema
 * @see mt#2763 — credential scrubbing at this layer
 *
 * ## Inline agent-spawns extraction (mt#3109)
 *
 * `AgentSpawnsPipeline.runForSession(agentSessionId)` is called inline from
 * `ingestSession()` (step "4d", right after the `writeCwdMatchLink` step) instead
 * of via a registered `createIntervalSweeper` sweep. This is deliberate, not an
 * oversight: spawn extraction is inherently per-parent-transcript work, which is
 * exactly the grain `ingestSession()` already operates at, and the early return
 * for an idempotent no-op re-ingest (see step 2 below) already gives the call the
 * incremental behavior a bespoke watermark would otherwise need to provide — see
 * mt#3109's spec `## Amendment 2026-07-23` for the full rationale. The pipeline
 * dependency is injected via the constructor's optional `spawnsExtractor`
 * parameter (defaulting to a real `AgentSpawnsPipeline`) so none of the four
 * production call sites that construct this service need to change.
 */

import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "../storage/schemas/agent-transcript-attachments-schema";
import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { getLoggableErrorSummary } from "../errors/index";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { isSidecarLineType } from "./transcript-source";
import { type AttachmentRow, buildAttachmentRow } from "./attachment-row-builder";
import { writeTurnsForTranscript, classifyWriteOutcome } from "./turn-writer";
import { writeCwdMatchLink } from "./session-link-writer";
import { WriterDivergenceScanner } from "./writer-divergence";
import { AgentSpawnsPipeline } from "./agent-spawns-pipeline";
import type { SpawnsPipelineRunResult } from "./agent-spawns-pipeline";
import {
  ToolCallProjectionPipeline,
  type ToolCallProjectionRunResult,
} from "./tool-call-projection-pipeline";
import { scrubValueDeep, type RedactionHit } from "./credential-scrubber";
import { sanitizeForPostgres, sanitizeForPostgresDeep } from "../storage/postgres-text-safety";
import type { ConversationId } from "../ids";
import { recordCredentialScrub, realCredentialScrubLogDeps } from "./credential-scrub-log";
import { resolveProjectIdentity } from "../project/identity";
import { resolveProjectScope } from "../project/scope-resolver";
import { isAllProjects } from "../project/scope";
import { SYNTHETIC_MODEL_SENTINEL } from "../ai/dispatch-models";

/**
 * Consecutive failed ingest attempts before a session is quarantined (mt#3278).
 *
 * Grounded in the sweep's own cadence rather than a round number: the backstop
 * runs every 30 minutes, so three consecutive failures is roughly 1.5 hours —
 * long enough that a transient DB blip or a brief outage resolves on its own
 * without burning the budget, short enough that a genuinely permanent failure
 * stops re-serializing multi-megabyte payloads well inside a day. A single
 * success resets the counter, so the threshold only ever measures an
 * uninterrupted run of failures.
 */
export const INGEST_QUARANTINE_THRESHOLD = 3;

/**
 * Cap on the stored `ingest_last_error` text. The whole point of the column is
 * a human-readable diagnosis; a Postgres error carrying a megabyte-scale
 * parameter dump (the mt#2903 log-bloat shape) is not more diagnostic for being
 * complete, and storing it would reproduce the bloat in the database.
 */
const INGEST_ERROR_TEXT_LIMIT = 2000;

/**
 * `harness` is NOT NULL, but a placeholder row created purely to record a
 * failure may have no harness known yet — the failure can precede any
 * successful read of the session. This sentinel is only ever written on that
 * insert path; the real value lands on the first successful upsert, which sets
 * `harness` on insert.
 */
const UNKNOWN_HARNESS = "unknown";

/**
 * The mt#3342 fill-if-null SET entries for the ingest upsert's
 * `onConflictDoUpdate`.
 *
 * EXPORTED so the integration test can exercise THIS fragment rather than a
 * hand-copied duplicate of it. That distinction is the whole point: a test that
 * re-types the SQL asserts only that the test's own SQL works, and would stay
 * green while the production statement regressed. The reviewer's finding on
 * PR #2412 was exactly this — the SQL change was unguarded by CI.
 *
 * `harness` needs NULLIF rather than a bare COALESCE: the column is NOT NULL,
 * so `recordIngestFailure`'s placeholder row cannot use NULL as its "no value
 * yet" marker and writes the string `'unknown'` instead. COALESCE would see a
 * non-null value and preserve the placeholder forever.
 *
 * Fill-if-null, NOT overwrite-always: an incremental ingest's
 * `extractStartedAt` only sees lines since the high-water-mark, so its
 * `startedAt` is LATER than the true session start and must never win over a
 * stored value.
 */
export function fillIfNullMetadataSet() {
  return {
    harness: sql`COALESCE(NULLIF(${agentTranscriptsTable.harness}, ${UNKNOWN_HARNESS}), EXCLUDED.harness)`,
    startedAt: sql`COALESCE(${agentTranscriptsTable.startedAt}, EXCLUDED.started_at)`,
    cwd: sql`COALESCE(${agentTranscriptsTable.cwd}, EXCLUDED.cwd)`,
    projectDir: sql`COALESCE(${agentTranscriptsTable.projectDir}, EXCLUDED.project_dir)`,
  };
}

/**
 * Pull the actual Postgres failure fields off a driver error (mt#3342).
 *
 * Drizzle wraps a failed statement in an Error whose `message` is
 * `"Failed query: <the entire SQL> params: <every bound value>"` — for this
 * upsert that is the whole transcript batch, tens of KB, and it does NOT
 * include the reason Postgres rejected it. `getLoggableErrorSummary` walks the
 * cause chain, but the chain terminates at Drizzle's own message, so the
 * SQLSTATE never reached the log OR `ingest_last_error`. 57 corrupted rows
 * existed with no recoverable explanation of what the original write error was.
 *
 * postgres.js attaches the PG error fields directly to the thrown object;
 * depending on the wrapping they may sit on the error or on its `cause`. Both
 * are checked. Returns `undefined` when nothing PG-shaped is found, so callers
 * can omit the field entirely rather than logging a bag of nulls.
 */
export function describeDriverError(
  err: unknown
):
  | { code?: string; detail?: string; constraint?: string; table?: string; routine?: string }
  | undefined {
  const candidates: unknown[] = [err];
  if (err !== null && typeof err === "object" && "cause" in err) {
    candidates.push((err as { cause: unknown }).cause);
  }
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    const pick = (key: string): string | undefined =>
      typeof c[key] === "string" && (c[key] as string).length > 0 ? (c[key] as string) : undefined;
    const code = pick("code");
    const detail = pick("detail");
    const constraint = pick("constraint");
    const table = pick("table");
    const routine = pick("routine");
    if (code || detail || constraint || table || routine) {
      return { code, detail, constraint, table, routine };
    }
  }
  return undefined;
}

/**
 * Narrow seam for the per-session spawn-extraction call `ingestSession` makes
 * inline (mt#3109). Deliberately narrower than `AgentSpawnsPipeline` itself —
 * a test double only needs to implement this one method, without modeling the
 * pipeline's full drizzle select+innerJoin+insert+onConflictDoUpdate query
 * surface across three tables, which the ingest-service test suite's
 * hand-rolled fake DB does not support.
 */
export interface SpawnsExtractor {
  runForSession(agentSessionId: string): Promise<SpawnsPipelineRunResult>;
}

/**
 * Narrow seam for the per-session tool-call projection call `ingestSession`
 * makes inline (mt#3329) — same rationale as `SpawnsExtractor` above: a test
 * double only needs this one method, not `ToolCallProjectionPipeline`'s full
 * drizzle select+insert+onConflictDoUpdate query surface.
 */
export interface ToolCallProjector {
  runForSession(agentSessionId: string): Promise<ToolCallProjectionRunResult>;
}

/**
 * Resolve a project uuid for a transcript from its recovered `cwd`, using the
 * same slug resolver the CLI/stdio MCP supplier uses for tasks/sessions/memories/
 * asks (ADR-021, mt#2416). Returns null (never throws) when `cwd` is absent, the
 * identity can't be resolved (e.g. no git remote), or no matching `projects` row
 * exists — mirroring the "unidentified -> ALL_PROJECTS" fail-open posture, since
 * ingestion must never block on project resolution (mt#2417, Phase 1.4).
 */
async function resolveIngestProjectId(
  cwd: string | null | undefined,
  db: PostgresJsDatabase
): Promise<string | null> {
  if (!cwd) return null;
  try {
    const identity = resolveProjectIdentity({ repoPath: cwd });
    if (identity.kind !== "resolved") return null;
    const scope = await resolveProjectScope(identity, db);
    return isAllProjects(scope) ? null : scope;
  } catch (err) {
    log.debug("[transcripts] Project id resolution failed for ingest; leaving unscoped", {
      cwd,
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}

export class AgentTranscriptIngestService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly source: TranscriptSource,
    /**
     * Spawn-extraction dependency (mt#3109), defaulting to a real
     * `AgentSpawnsPipeline` bound to `db`. Override only from tests — see this
     * class's docblock's "Inline agent-spawns extraction" section.
     */
    private readonly spawnsExtractor: SpawnsExtractor = new AgentSpawnsPipeline(db),
    /**
     * Tool-call projection dependency (mt#3329), defaulting to a real
     * `ToolCallProjectionPipeline` bound to `db`. Override only from tests —
     * mirrors `spawnsExtractor` immediately above.
     */
    private readonly toolCallProjector: ToolCallProjector = new ToolCallProjectionPipeline(db),
    /**
     * Injectable warn sink (mt#3628), defaulting to the real shared logger's
     * `warn`. Exists so the missing-genuine-model wiring test can observe the
     * emission via a plain injected function instead of `spyOn(log)`.
     */
    private readonly logWarn: (message: string, meta?: Record<string, unknown>) => void = log.warn
  ) {}

  /**
   * Ingest a single session identified by its agent session ID.
   *
   * Returns a typed result so the caller can distinguish success from a caught
   * failure. Three paths — HWM read, stream, upsert — ABORT immediately on
   * failure (mt#2789: HWM-read failure moved from "swallow and proceed" to
   * "abort" so it can no longer append a whole-file re-collect onto a stored
   * transcript, see the comment at the HWM read site). Two further paths —
   * turn-row materialization, attachment insert — are best-effort: they log
   * and continue, surfacing their error on an otherwise-successful return.
   * Either way, a non-undefined `error` means `ingestAll` counts the session
   * in `sessionsErrored` honestly (mt#1444).
   *
   * @param session - The discovered session metadata (from discoverSessions() or a direct lookup).
   * @param opts.sessionEnded - mt#3131 (D2): true ONLY when this ingest call
   *   corresponds to genuine positive evidence the session has terminated —
   *   the harness's own SessionEnd lifecycle event, not a routine incremental
   *   poll/sweep. Every other caller (the boot sweep, the filesystem watcher,
   *   the cadence sweep, a manual `--all`/`--conversationId` ingest) MUST omit
   *   this or pass `false`. See `endedAt` derivation below for why.
   * @returns `{ ingested: number; error?: Error }` — `ingested` is the number of new
   *   lines written (0 on idempotent re-run or on an abort path); `error` is set
   *   when any of the five internal paths above hit a failure.
   */
  async ingestSession(
    session: DiscoveredSession,
    opts?: { sessionEnded?: boolean }
  ): Promise<IngestSessionResult> {
    const sessionEnded = opts?.sessionEnded ?? false;
    const { agentSessionId, harness, jsonlPath, mtime } = session;

    // ── 1. Read the current high-water-mark (and quarantine state) ───────────
    let highWaterMark: Date | null = null;
    // mt#3482: whether this conversation already has a row in agent_transcripts.
    // Read here rather than with a second SELECT later — §3a below needs it to
    // decide whether the attachment insert has a parent row to reference.
    let parentRowExists = false;
    try {
      const rows = await this.db
        .select({
          lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
          ingestQuarantinedAt: agentTranscriptsTable.ingestQuarantinedAt,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);

      // mt#3278: a quarantined session has failed to ingest
      // INGEST_QUARANTINE_THRESHOLD times running. Retrying it costs a
      // multi-megabyte serialize plus a doomed DB round-trip on every sweep,
      // forever, and produces no new information — the same content fails the
      // same way. Skip it, and report it as quarantined rather than errored so
      // the sweep can distinguish "keeps failing, still trying" from "given up
      // on, needs a human". A successful ingest clears the flag, so fixing the
      // underlying cause (e.g. shipping a sanitizer) un-quarantines on the
      // first pass that gets through.
      if (rows[0]?.ingestQuarantinedAt) {
        log.debug(`Skipping quarantined session ${agentSessionId}`, {
          quarantinedAt: rows[0].ingestQuarantinedAt.toISOString(),
        });
        return { ingested: 0, quarantined: true };
      }

      highWaterMark = rows[0]?.lastIngestedJsonlTimestamp ?? null;
      parentRowExists = rows[0] !== undefined;
    } catch (err) {
      const hwmReadError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to read high-water-mark for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
      // mt#2789: abort this session's ingest rather than proceeding with
      // highWaterMark=null. Proceeding used to mean "treat as no prior
      // ingest" — re-collecting and re-appending the ENTIRE transcript onto
      // whatever is already stored. That was one of the two concrete
      // duplication mechanisms found in the mt#2789 diagnosis (the other
      // being the plain concurrent-actor race, which the uuid-dedup UPDATE
      // below now closes). We picked abort over "proceed, uuid-dedup makes
      // it safe" for two reasons even though the dedup WOULD in fact make a
      // full re-collect safe: (a) it avoids the O(whole-transcript) resend
      // and the O(new*existing) dedup-subquery cost on every transient HWM
      // read failure, and (b) it keeps the failure legible — the sweep
      // already counts `result.error` (mt#1444) and will retry this session
      // on the next pass once the read succeeds, so nothing is lost by not
      // pushing through on a degraded read.
      return { ingested: 0, error: hwmReadError };
    }

    // ── 2. Stream new lines ──────────────────────────────────────────────────
    // Source yields all retained types (user/assistant/attachment/system per
    // `RETAINED_TYPES` in claude-code-transcript-source). The ingest routes
    // them to two destinations:
    //   - user/assistant turn content → `agent_transcripts.transcript` jsonb
    //     (backwards-compat for existing turn-extractor / FTS / summary etc.)
    //   - attachment/system side material → `agent_transcript_attachments`
    //     (mt#2022 — new sibling table for context-inspector use case)
    //
    // `lineIndex` increments on every retained line yielded — including those
    // filtered out by the HWM gate — so the counter is stable across re-ingest
    // for an append-only JSONL file. Attachments use it as part of their PK.
    const newLines: RawTurnLine[] = [];
    // mt#3656: accumulates the `last-prompt` leaves and `parentUuid` edges from
    // the raw pass below, so a two-writer fork is detected where the raw bytes
    // are read — the only place the signal exists.
    const divergenceScanner = new WriterDivergenceScanner();
    const newAttachmentRows: AttachmentRow[] = [];
    let latestTs: Date | null = null;
    let lineIndex = -1;
    // mt#2763: credential-shaped strings redacted out of raw lines this
    // call, aggregated across the whole stream and logged once below (the
    // counted signal — see credential-scrub-log.ts).
    const allRedactions: RedactionHit[] = [];
    // mt#3278: counts of Postgres-unrepresentable codepoints replaced across
    // this batch, logged once below rather than per line.
    let unsafeCodepointsReplaced = 0;
    let sanitizeKeyCollisions = 0;

    try {
      // mt#3288: pass the path this session was discovered at. Without it a
      // discovery-backed source re-scans every transcript in the corpus to
      // resolve the id, which made `ingestAll` quadratic.
      for await (const line of this.source.readSession(agentSessionId, jsonlPath)) {
        // mt#3656: feed EVERY line to the divergence scanner before any gate
        // below can drop it. This must precede the timestamp check: a
        // `last-prompt` row — the only writer-identity trace the format offers
        // — carries no `timestamp` at all, so `if (!tsStr) continue` discards
        // it, and it is retained by neither the transcript jsonb nor the
        // attachments table. The verdict is a whole-file property, so the
        // scanner also wants the lines the high-water-mark gate skips.
        divergenceScanner.observe(line);

        // mt#3836: a sidecar row is yielded for the scanner's benefit only —
        // it is never stored, and it must NOT consume a `lineIndex`.
        //
        // `lineIndex` is not a loop counter: it is half of
        // `agent_transcript_attachments`' primary key
        // (`primaryKey({ columns: [agentSessionId, lineIndex] })`). Counting a
        // newly-retained type here would renumber every attachment after the
        // first sidecar row in every transcript already ingested, changing
        // their keys and duplicating rows on re-ingest. So the `continue`
        // deliberately sits ABOVE the increment, and
        // `scripts/backfill-agent-transcript-attachments.ts` — the other
        // writer of that key — applies the identical rule.
        if (isSidecarLineType(line)) continue;

        lineIndex++;

        const tsStr = this.source.getJsonlTimestamp(line);
        if (!tsStr) continue;

        const tsDate = new Date(tsStr);
        if (isNaN(tsDate.getTime())) continue;

        // Incremental gate: skip lines already ingested.
        if (highWaterMark !== null && tsDate <= highWaterMark) continue;

        const lineType = typeof line.type === "string" ? line.type : "";
        if (lineType === "user" || lineType === "assistant") {
          // mt#2763: scrub BEFORE the line is retained — this is the
          // durable-copy write path (agent_transcripts.transcript JSONB).
          const { value: scrubbedLine, redactions } = scrubValueDeep(line);
          if (redactions.length > 0) allRedactions.push(...redactions);
          // mt#3278: and make it storable. Postgres cannot hold U+0000 in a
          // text-derived column, so a line carrying one fails the upsert
          // identically on every retry — permanently freezing the transcript.
          const {
            value: safeLine,
            replaced,
            keyCollisions,
          } = sanitizeForPostgresDeep(scrubbedLine);
          unsafeCodepointsReplaced += replaced;
          sanitizeKeyCollisions += keyCollisions;
          newLines.push(safeLine);
        } else if (lineType === "attachment" || lineType === "system") {
          // mt#2763: scrub BEFORE buildAttachmentRow captures `content: line`
          // verbatim (attachment-row-builder.ts) — the other durable-copy
          // write path (agent_transcript_attachments.content).
          const { value: scrubbedLine, redactions } = scrubValueDeep(line);
          if (redactions.length > 0) allRedactions.push(...redactions);
          const {
            value: safeLine,
            replaced,
            keyCollisions,
          } = sanitizeForPostgresDeep(scrubbedLine);
          unsafeCodepointsReplaced += replaced;
          sanitizeKeyCollisions += keyCollisions;
          const row = buildAttachmentRow(agentSessionId, lineIndex, safeLine, tsDate);
          if (row !== null) newAttachmentRows.push(row);
        }

        if (latestTs === null || tsDate > latestTs) {
          latestTs = tsDate;
        }
      }
    } catch (err) {
      log.warn(`Failed to stream lines for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
      // Return 0 — don't partially-commit a broken read.
      // Surface the error so the sweep can count it (mt#1444).
      return { ingested: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }

    // mt#2763: emit the counted signal before the "no new lines" idempotent
    // return below, so a redaction is logged even in the edge case where the
    // ONLY retained line that scrubbed was an attachment/system line whose
    // (already-scrubbed) content buildAttachmentRow then rejected as
    // malformed (returns null) — the redaction still happened even though
    // nothing ended up persisted for that line. NOTE: this call cannot fire
    // for lines the HWM gate filtered out, or for unrecognized line types —
    // both `continue` / fall through BEFORE scrubValueDeep is ever called
    // (see the loop above), so allRedactions only ever contains hits from
    // lines that passed the HWM gate and matched a retained type. Best-effort
    // logging; see credential-scrub-log.ts's own error-swallowing posture.
    if (allRedactions.length > 0) {
      recordCredentialScrub(agentSessionId, allRedactions, realCredentialScrubLogDeps);
    }

    // mt#3278: the sanitization is lossy, so say so once per batch rather than
    // silently. Rare in practice (7 of 982 local conversations carried one), and
    // when it does fire it is the difference between this transcript ingesting
    // and it being frozen forever.
    if (unsafeCodepointsReplaced > 0) {
      log.info(
        `Replaced ${unsafeCodepointsReplaced} Postgres-unrepresentable codepoint(s) for session ${agentSessionId}`,
        { agentSessionId, replaced: unsafeCodepointsReplaced }
      );
    }

    // A key collision means a value was dropped, not merely rewritten — a
    // strictly worse outcome than the substitution above, so it gets its own
    // line at `warn`. Expected to be permanently zero (PR #2373 R1).
    if (sanitizeKeyCollisions > 0) {
      log.warn(
        `Sanitization collapsed ${sanitizeKeyCollisions} duplicate object key(s) for session ${agentSessionId}, dropping the later value`,
        { agentSessionId, keyCollisions: sanitizeKeyCollisions }
      );
    }

    // mt#3656: resolve the writer-divergence verdict over the WHOLE file the
    // scan just walked. Computed HERE, above the no-new-lines early return,
    // because the verdict is a property of the file rather than of this batch:
    // a conversation ingested before this detector shipped never receives new
    // lines again, so a verdict computed below the return would be discarded
    // for the entire existing corpus (PR #2656 R1).
    //
    // Logged at WARN when it fires because a fork means a branch is being
    // silently orphaned — the failure mode has no other error surface anywhere
    // in the system, which is the whole reason this exists.
    const divergenceVerdict = divergenceScanner.verdict();
    if (divergenceVerdict.divergentTips.length > 0) {
      this.logWarn(
        `[transcripts] Writer divergence in session ${agentSessionId}: ${divergenceVerdict.divergentTips.length} last-prompt records name leaves on different branches — two writers each held the tip`,
        { agentSessionId, divergentTips: divergenceVerdict.divergentTips }
      );
    }
    if (divergenceVerdict.unresolvedLeaves.length > 0) {
      // Not a divergence claim — the opposite. These leaves could not be placed
      // in the tree, so the verdict is silent about them rather than guessing.
      log.debug(
        `[transcripts] ${divergenceVerdict.unresolvedLeaves.length} unplaceable last-prompt leaf/leaves for session ${agentSessionId}`,
        { agentSessionId }
      );
    }

    if (newLines.length === 0 && newAttachmentRows.length === 0) {
      // The transcript upsert below is skipped, so the verdict has to be
      // written on its own here or it is lost for every already-ingested
      // conversation. Conditional in SQL rather than unconditional: the WHERE
      // clause makes a steady-state sweep write NOTHING, so this does not
      // reintroduce the per-tick write amplification the early return exists
      // to avoid.
      //
      // The other early returns between the scan and the upsert (attachment
      // write failure, upsert failure) deliberately do NOT write the verdict.
      // They differ in kind: those abort a FAILED ingest that will be retried,
      // and the scan is re-run from scratch on every pass, so the verdict is
      // re-derived rather than lost. This path is the only one where "the next
      // pass" never comes.
      await this.persistDivergenceVerdict(agentSessionId, divergenceVerdict.divergentTips);

      log.debug(
        `No new lines for session ${agentSessionId} (high-water-mark: ${highWaterMark?.toISOString() ?? "none"})`
      );
      // Idempotent re-run. (mt#2789: a HWM-read failure aborts above, before
      // this point is reached, so there is no swallowed HWM error to surface
      // here anymore.)
      return { ingested: 0, error: undefined };
    }

    // ── 3. Derive metadata from the source's DiscoveredSession ───────────────
    const startedAt = extractStartedAt(newLines, this.source);
    // mt#3131 (D2): `endedAt` asserts TERMINATION, not "last observed". Every
    // ingest call used to set it to `latestTs ?? mtime` unconditionally — since
    // ingest runs on every incremental poll/sweep for a conversation, this made
    // `endedAt` advance on every call, including for a conversation that is
    // still actively running. A consumer reading `endedAt` non-null had no way
    // to tell "this finished" from "this is the last line we happened to see."
    // Only set it when THIS call carries positive termination evidence
    // (`opts.sessionEnded`, wired from the harness's own SessionEnd hook —
    // see transcripts.ts's `ended` param and
    // .minsky/hooks/transcript-ingest-on-session-end.ts). Routine polls never
    // touch it (see the onConflictDoUpdate SET clause below); `lastIngestedJsonlTimestamp`
    // already carries the "last observed" signal for every caller (exposed to
    // the frontend as `lastActivityAt`, routes/conversations.ts).
    const endedAt = sessionEnded ? (latestTs ?? mtime) : null;

    // ── 4. Upsert into agent_transcripts ─────────────────────────────────────
    // Single atomic statement: INSERT … ON CONFLICT (agent_session_id) DO UPDATE.
    //
    // mt#2789: the append is now idempotent BY LINE `uuid`, not just
    // timestamp-gated. Diagnosis found the observed subagent-transcript
    // duplication was a concurrent-ingest race: two actors (the cockpit
    // watcher, the MCP boot sweep, the SessionEnd hook — any two of the N
    // processes that can call ingestSession) both read the same
    // high-water-mark, both collect the same "new" batch, and both append.
    // The in-process HWM gate at step 2 is a cheap first-pass filter but
    // can't see a concurrent actor's read; only the DB has the information
    // needed to detect the race, and only at the moment of the write.
    //
    // The fix: filter `EXCLUDED.transcript` down to elements whose `uuid` is
    // NOT already present in the stored `transcript` array, via a correlated
    // subquery over `jsonb_array_elements`, before concatenating. This is
    // race-free WITHOUT an advisory lock because the UPDATE's row lock
    // already serializes concurrent writers to the same `agent_session_id`:
    // under Postgres READ COMMITTED, a blocked `ON CONFLICT DO UPDATE`
    // re-evaluates its SET expressions against the just-committed row once
    // unblocked — so the second writer's uuid check sees the first writer's
    // already-appended lines and correctly filters them out.
    //
    // Lines without a `uuid` are always appended (never treated as
    // duplicates) — Claude Code's retained user/assistant lines always carry
    // one, so this is a defensive default for a case that should not occur
    // in practice, not a silent-drop.
    //
    // `lastIngestedJsonlTimestamp` uses GREATEST(existing, EXCLUDED) rather
    // than a flat overwrite so a racing writer that read an OLDER
    // high-water-mark (and is therefore behind) cannot regress the
    // watermark below a value a faster concurrent writer already advanced
    // it to — regressing it would cause the NEXT ingest to re-collect
    // already-ingested lines (harmless now that the append is uuid-deduped,
    // but wasteful).
    //
    // Project scoping (mt#2417, Phase 1.4): resolve from the recovered cwd.
    // Unlike `cwd` (strictly insert-only), `project_id` IS refreshed on
    // conflict via COALESCE-forward below — a session first ingested before
    // its cwd was recoverable can still get scoped once a later ingest
    // resolves it, without ever downgrading an already-resolved project back
    // to null (mirrors the `writeCwdMatchLink` precedence note above).
    const resolvedProjectId = await resolveIngestProjectId(session.cwd, this.db);

    // mt#3089: extract the model id from THIS batch's new assistant lines.
    // See extractModelFromNewLines's doc comment for why a later batch that
    // doesn't re-include the model-bearing turn must not regress an
    // already-stored value — handled below via COALESCE on conflict, mirroring
    // projectId's precedence pattern.
    const extractedModel = extractModelFromNewLines(newLines);

    // mt#3089 R1 review — extractor observability: a null result is
    // unremarkable when the batch has no assistant lines at all (nothing to
    // extract from), but a GENUINE miss when assistant lines ARE present and
    // none carried a usable model — either every one was a synthetic retry,
    // or the harness's transcript shape has drifted out from under the
    // extractor. Logging only the latter case keeps the common path quiet
    // while making a future format drift visible instead of silently
    // reproducing the 0/1,729 state this task exists to fix.
    {
      const assistantLineCount = countAssistantLines(newLines);
      const { shouldWarn } = decideMissingModelWarn(extractedModel, assistantLineCount);
      if (shouldWarn) {
        this.logWarn(
          `[transcripts] No genuine model id found in ${assistantLineCount} assistant line(s) for session ${agentSessionId} — possible transcript-shape drift`,
          { agentSessionId, assistantLineCount }
        );
      }
    }

    // ── 3a. Ensure the parent transcript row exists (mt#3482) ────────────────
    // `agent_transcript_attachments.agent_session_id` carries an FK to
    // `agent_transcripts`, and §3b below deliberately runs BEFORE the transcript
    // upsert that would create that parent row (see §3b's own rationale). For a
    // conversation being ingested for the FIRST time there is no row to
    // reference yet, so the attachment insert violates the FK and aborts the
    // whole ingest. Measured 2026-07-31: 68 distinct conversations hit this in
    // 25h — and because each abort routes through `recordIngestFailure`, every
    // new conversation burned 2 of the INGEST_QUARANTINE_THRESHOLD (3)
    // consecutive failures before ingesting a single line.
    //
    // This keeps BOTH invariants rather than trading one for the other. It
    // writes the same real metadata the upsert below would have inserted —
    // never a placeholder, because a stub `harness` would then be pinned
    // permanently by that upsert's fill-if-null group (mt#3342) — and it
    // deliberately does NOT write `transcript`, `lastIngestedJsonlTimestamp`, or
    // `ingestedAt`. The high-water mark still advances only in the upsert, so an
    // attachment failure after this point aborts before the watermark moves,
    // exactly as mt#3278 requires.
    //
    // Scoped to the case that needs it: only when this batch carries attachments
    // AND step 1 saw no existing row. `onConflictDoNothing` covers the race
    // where a concurrent ingester created the row in between.
    if (newAttachmentRows.length > 0 && !parentRowExists) {
      try {
        await this.db
          .insert(agentTranscriptsTable)
          .values({
            agentSessionId,
            harness,
            startedAt: startedAt ?? undefined,
            cwd: session.cwd ?? undefined,
            projectDir: deriveProjectDir(jsonlPath),
            projectId: resolvedProjectId ?? undefined,
          })
          .onConflictDoNothing();
      } catch (err) {
        const parentRowError = err instanceof Error ? err : new Error(String(err));
        log.error(
          `Parent transcript-row insert FAILED for session ${agentSessionId} — aborting ingest before the high-water mark advances`,
          { error: getLoggableErrorSummary(err), driver: describeDriverError(err) }
        );
        await this.recordIngestFailure(agentSessionId, parentRowError);
        return { ingested: 0, error: parentRowError };
      }
    }

    // ── 3b. Insert attachment rows BEFORE the transcript upsert (mt#3278) ────
    // Ordering is load-bearing, not cosmetic. The high-water mark advances as
    // part of the transcript upsert below; anything written AFTER it that fails
    // is past the watermark and will never be retried, so its rows are lost
    // permanently — and unlike a failed transcript upsert, which visibly
    // freezes the row, an attachment loss leaves no symptom to notice later.
    // Running the attachment insert first means a failure here aborts before
    // the watermark moves, and the next sweep re-collects and retries both.
    //
    // Re-running is safe: the PK is `(agent_session_id, line_index)`, line_index
    // is stable across re-reads of an append-only JSONL, and the insert is
    // ON CONFLICT DO NOTHING — so rows written by an attempt whose transcript
    // upsert then failed are simply no-ops on the retry.
    let attachmentsWritten = 0;
    if (newAttachmentRows.length > 0) {
      try {
        await this.db
          .insert(agentTranscriptAttachmentsTable)
          .values(newAttachmentRows)
          .onConflictDoNothing();
        attachmentsWritten = newAttachmentRows.length;
      } catch (err) {
        const attachmentError = err instanceof Error ? err : new Error(String(err));
        log.error(
          `Attachment insert FAILED for session ${agentSessionId} (${newAttachmentRows.length} rows) — aborting ingest before the high-water mark advances`,
          { error: getLoggableErrorSummary(err) }
        );
        await this.recordIngestFailure(agentSessionId, attachmentError);
        return { ingested: 0, error: attachmentError };
      }
    }

    // mt#3342: `harness`, `cwd`, `project_dir`, and `started_at` used to be
    // INSERT-ONLY here — absent from the SET clause below, so whatever the
    // FIRST write for a conversation id put there was permanent. That made a
    // failure stub unrepairable: `recordIngestFailure` creates a placeholder
    // row with `harness: 'unknown'` and no `started_at`, so any conversation
    // whose first-ever write was a failure carried those placeholders forever,
    // even after every later ingest succeeded — and mt#3278's self-healing
    // reset cleared the failure columns, leaving no trace of why. 57 rows were
    // in that state when this was found, and the count was still growing.
    //
    // They are FILL-IF-NULL now, not overwrite-always: an incremental ingest's
    // `extractStartedAt` sees only the NEW lines, so its `startedAt` is LATER
    // than the true session start and must never win over a stored value.
    try {
      await this.db
        .insert(agentTranscriptsTable)
        .values({
          agentSessionId,
          harness,
          transcript: newLines,
          startedAt: startedAt ?? undefined,
          endedAt: endedAt ?? undefined,
          model: extractedModel ?? undefined,
          // mt#1445: use the session's recovered working directory if the
          // source could provide one; otherwise leave the column NULL rather
          // than substituting the JSONL path. Downstream consumers querying
          // `cwd` expect a working directory, not a transcript path.
          cwd: session.cwd ?? undefined,
          projectDir: deriveProjectDir(jsonlPath),
          projectId: resolvedProjectId ?? undefined,
          lastIngestedJsonlTimestamp: latestTs ?? undefined,
          ingestedAt: new Date(),
          // mt#3656: an empty array is a real verdict ("the writers agreed"),
          // distinct from NULL ("never checked") — hence the paired timestamp.
          divergentTipLeaves: divergenceVerdict.divergentTips,
          divergenceCheckedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: agentTranscriptsTable.agentSessionId,
          set: {
            // mt#3342 fill-if-null group — see fillIfNullMetadataSet's docblock
            // for why `harness` needs NULLIF and why this is fill-if-null
            // rather than overwrite-always. Shared with the integration test so
            // CI guards this exact fragment.
            ...fillIfNullMetadataSet(),
            transcript: sql`COALESCE(${agentTranscriptsTable.transcript}, '[]'::jsonb) || (
              SELECT COALESCE(jsonb_agg(new_elem ORDER BY ord), '[]'::jsonb)
              FROM jsonb_array_elements(EXCLUDED.transcript) WITH ORDINALITY AS t(new_elem, ord)
              WHERE (new_elem->>'uuid') IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(${agentTranscriptsTable.transcript}, '[]'::jsonb)) AS existing_elem
                  WHERE existing_elem->>'uuid' = new_elem->>'uuid'
                )
            )`,
            // mt#3131 (D2): only overwrite the stored `endedAt` when THIS call
            // carries genuine termination evidence. A routine poll
            // (`sessionEnded` false) must leave whatever is already stored
            // untouched — it must never REGRESS an already-recorded end time
            // back toward "unknown" (a stale/duplicate SessionEnd delivery is
            // not evidence the conversation is live again), and it must not
            // advance a not-yet-ended conversation's endedAt just because a
            // sweep happened to observe new lines.
            endedAt: sessionEnded ? sql`EXCLUDED.ended_at` : sql`${agentTranscriptsTable.endedAt}`,
            // NULL-safety: Postgres GREATEST *ignores* NULL arguments (result
            // is NULL only when ALL args are NULL) — unlike MySQL, where any
            // NULL poisons the result. GREATEST(NULL, ts) = ts here, so a
            // NULL existing watermark advances and a NULL incoming one cannot
            // regress a stored value. Verified empirically on PG17.
            lastIngestedJsonlTimestamp: sql`GREATEST(${agentTranscriptsTable.lastIngestedJsonlTimestamp}, EXCLUDED.last_ingested_jsonl_timestamp)`,
            ingestedAt: sql`EXCLUDED.ingested_at`,
            projectId: sql`COALESCE(${agentTranscriptsTable.projectId}, EXCLUDED.project_id)`,
            // mt#3656: OVERWRITE-ALWAYS, unlike the fill-if-null columns above.
            // Those are fill-if-null because an incremental batch may simply
            // lack the data (a later batch without the model-bearing turn must
            // not regress a resolved model). The divergence verdict is the
            // opposite: it is recomputed from the ENTIRE file on every pass —
            // `last-prompt` rows are never high-water-mark filtered — so the
            // newest computation always saw at least as much as the stored one.
            // Overwriting is also what lets a fork that is later resolved stop
            // being reported.
            divergentTipLeaves: sql`EXCLUDED.divergent_tip_leaves`,
            divergenceCheckedAt: sql`EXCLUDED.divergence_checked_at`,
            // mt#3089: never regress an already-resolved model with a later
            // batch that didn't happen to include the model-bearing turn.
            model: sql`COALESCE(${agentTranscriptsTable.model}, EXCLUDED.model)`,
            // mt#3278: a successful upsert clears the failure record ENTIRELY.
            // This is what makes quarantine self-healing — once the cause is
            // fixed, the first pass that gets through un-quarantines the session
            // with no manual step.
            //
            // All four columns reset together, deliberately: leaving
            // `ingestLastFailedAt` set while the count is 0 and the error is
            // NULL produces a row that reads as "currently failing" to anyone
            // scanning for recent failures, which is exactly the misleading
            // signal this task exists to remove. The failure history lives in
            // the logs; these columns describe CURRENT state (PR #2373 R1).
            ingestFailureCount: sql`0`,
            ingestLastError: sql`NULL`,
            ingestLastFailedAt: sql`NULL`,
            ingestQuarantinedAt: sql`NULL`,
          },
        });
    } catch (err) {
      const upsertError = err instanceof Error ? err : new Error(String(err));
      // mt#3342: log the DRIVER's reason (SQLSTATE / detail / constraint), not
      // only Drizzle's "Failed query: <sql> params: <whole transcript>" blob.
      // The blob is tens of KB and says nothing about why Postgres refused the
      // write; without the fields below the failure is not diagnosable after
      // the fact, which is how this bug's root cause stayed unknown.
      log.error(`Transcript upsert FAILED for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
        driver: describeDriverError(err),
      });
      await this.recordIngestFailure(agentSessionId, upsertError);
      return { ingested: 0, error: upsertError };
    }

    // ── 4b. Materialize per-turn rows for FTS (ADR-019, mt#2381) ──────────────
    // Extraction rides with capture: read back the full MERGED transcript (the
    // upsert just concatenated the new lines onto any prior transcript) and
    // upsert text-only turn rows. This makes the session FTS-searchable with no
    // embedding API call — `fts_text` is a GENERATED column populated on the
    // text write. The embedding vector is filled later by the vector-only
    // backfill (PerTurnEmbeddingPipeline); writeTurnsForTranscript never touches
    // the `embedding` column, so an already-embedded turn is not clobbered.
    // Turn ordering is assigned over the WHOLE transcript, so we extract from the
    // full merged row, not from the incremental `newLines` slice.
    let turnExtractError: Error | undefined;
    let persistedCwd: string | null = null;
    try {
      const fullRows = await this.db
        .select({
          transcript: agentTranscriptsTable.transcript,
          cwd: agentTranscriptsTable.cwd,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);
      const fullTranscript = fullRows[0]?.transcript ?? null;
      persistedCwd = fullRows[0]?.cwd ?? null;
      const writeResult = await writeTurnsForTranscript(this.db, agentSessionId, fullTranscript);
      // mt#3514: derive the degraded/ok verdict from classifyWriteOutcome
      // rather than restating its conditions. This site is the THIRD copy of
      // that logic (the sweep and index-embeddings-command were the others),
      // and restating it is exactly how it fell out of date: it enumerated
      // nonEmptyYieldedZero and erroredChunks, so a failed orphan-DELETE — a
      // new error condition the sweep honors — was silently ingested as a
      // success. Call the shared classifier; name the cause in the message.
      const classification = classifyWriteOutcome(writeResult);
      if (classification.countNonEmptyYieldedZero) {
        // mt#2457 SC3: a non-empty transcript that yields zero turns is an
        // extraction failure, not a "nothing new to write" no-op — the throw-only
        // catch below can't see this case (writeTurnsForTranscript already logs a
        // WARN; this makes it count as a degraded ingest too, same as a throw).
        turnExtractError = new Error(
          `Non-empty transcript yielded zero turns for session ${agentSessionId}`
        );
      } else if (classification.bucket === "errored") {
        // A failed bulk-upsert chunk is a partial write, and a failed orphan
        // delete leaves stale rows the upsert cannot reach — neither is a
        // success. Surface either as a degraded ingest so ingestAll counts this
        // session in sessionsErrored, matching the sweep and single-session
        // classifications.
        const causes: string[] = [];
        if (writeResult.erroredChunks > 0) {
          causes.push(`${writeResult.erroredChunks} turn-upsert chunk(s) failed`);
        }
        if (writeResult.orphanDeleteFailed) {
          causes.push("orphaned-turn-row cleanup failed");
        }
        turnExtractError = new Error(`${causes.join("; ")} for session ${agentSessionId}`);
      }
    } catch (err) {
      turnExtractError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to materialize turn rows for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
      // Don't fail the whole ingest — the transcript upsert already succeeded.
      // Surface the error so the sweep can count degraded ingests.
    }

    // ── 4c. Write cwd_match link into minsky_session_links (mt#2441) ────────
    // Runs from THIS shared ingest core so every ingest path — transcripts_ingest,
    // the MCP boot sweep, the SessionEnd hook, and the cadence sweep — writes
    // the same link with no per-consumer duplication (all four funnel through
    // ingestSession). No-ops (no DB call) when the resolved cwd doesn't
    // resolve to a session workspace path — the expected common case per the
    // mt#2749 finding (subagents don't chdir), not an error. Never allowed to
    // fail the ingest: writeCwdMatchLink swallows its own DB errors, and this
    // try/catch is a defensive backstop only.
    //
    // Prefer `session.cwd` (the freshest value from THIS discovery) over
    // `persistedCwd` (the stored column, which the upsert above never updates
    // on conflict — `cwd` is insert-only, mt#1445). Without this precedence a
    // session first ingested before its cwd was recoverable, then re-ingested
    // once the source CAN report it, would silently never get a link: the
    // persisted column stays NULL forever while `session.cwd` carries the
    // real value on every subsequent call (PR #1899 R1).
    try {
      await writeCwdMatchLink(this.db, agentSessionId, session.cwd ?? persistedCwd);
    } catch (err) {
      log.warn(`Failed to write cwd_match link for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
    }

    // ── 4d. Extract agent spawns for this parent transcript inline (mt#3109) ──
    // AgentSpawnsPipeline.runForSession() scans ONLY this session's
    // is_spawn_boundary turns (already materialized by writeTurnsForTranscript
    // at step 4b above) and upserts into agent_spawns, plus writes the
    // subagent_spawn minsky_session_links row (mt#2756) when the spawn's child
    // conversation resolves. Reached only on THIS path — never on the
    // idempotent-no-op early return at step 2 — so a long-lived session with
    // many spawns is re-scanned only when it actually receives new content,
    // not on every unattended sweep tick; this per-session grain IS the
    // incremental behavior a bespoke watermark mode would otherwise need to
    // provide (see mt#3109's spec `## Amendment 2026-07-23`). Idempotent
    // (upserts on (parent_agent_session_id, parent_turn_index)) and already
    // defensive internally — `runForSession` catches its own query failures,
    // logs, and returns a zeroed result rather than throwing — so this
    // try/catch is a last-resort backstop only, matching the
    // `writeCwdMatchLink` posture immediately above.
    try {
      await this.spawnsExtractor.runForSession(agentSessionId);
    } catch (err) {
      log.warn(`Failed to extract agent spawns for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
    }

    // ── 4e. Project tool calls for this session inline (mt#3329) ────────────
    // ToolCallProjectionPipeline.runForSession() scans ONLY this session's
    // non-null tool_calls turns (already materialized by writeTurnsForTranscript
    // at step 4b above) and upserts one row per tool_use block into
    // agent_tool_call_projection — the cheap, ordered read surface the EngProd
    // miner (mt#3330) and mt#1120's supervision analysis both need, so neither
    // consumer has to scan the raw tool_calls jsonb. Reached only on THIS path
    // (never the idempotent-no-op early return at step 2), matching step 4d's
    // incremental-by-construction rationale. Idempotent (upserts on
    // (agent_session_id, turn_index, ordinal)) and already defensive
    // internally — `runForSession` catches its own query/insert failures, logs,
    // and returns a zeroed result rather than throwing — so this try/catch is a
    // last-resort backstop only, matching the step 4d posture immediately above.
    try {
      await this.toolCallProjector.runForSession(agentSessionId);
    } catch (err) {
      log.warn(`Failed to project tool calls for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
    }

    // (Attachment rows were written at step 3b, deliberately BEFORE the
    // transcript upsert advanced the high-water mark — see the comment there.)

    log.debug(
      `Ingested ${newLines.length} turn lines + ${attachmentsWritten} attachment rows for session ${agentSessionId}`,
      {
        highWaterMark: highWaterMark?.toISOString() ?? "none",
        newHighWaterMark: latestTs?.toISOString(),
      }
    );

    // Surface a turn-extract failure on success — the caller may want to know
    // turn rows weren't materialized (FTS lag). (mt#2789: HWM-read failure can
    // no longer reach this point — it aborts above. mt#3278: neither can an
    // attachment failure, which now aborts at step 3b instead of being
    // swallowed here after the watermark moved.) The `ingested` count counts
    // turn lines only, matching the pre-mt#2022 semantics; attachments live in
    // their own table and don't roll into this number.
    return {
      ingested: newLines.length,
      error: turnExtractError,
    };
  }

  /**
   * Record a failed ingest attempt against the session's row, quarantining it
   * once {@link INGEST_QUARANTINE_THRESHOLD} consecutive failures have
   * accumulated (mt#3278).
   *
   * Written as an upsert rather than an update because a session whose very
   * FIRST ingest fails has no row yet — an UPDATE would silently match nothing
   * and the failure would never be counted, which is precisely the
   * "indistinguishable from normal" shape this task removes. The insert carries
   * only the identity columns plus the failure record; it deliberately does NOT
   * set `last_ingested_jsonl_timestamp`, so a placeholder row created this way
   * still has a null watermark and re-collects everything on the next attempt.
   *
   * Best-effort: a failure to record a failure is logged and swallowed. The
   * caller is already returning an error for the original problem, and throwing
   * from here would replace a specific diagnosis with a bookkeeping error.
   */
  /**
   * Write the writer-divergence verdict on the no-new-lines path, where the
   * transcript upsert never runs (mt#3656, PR #2656 R1).
   *
   * The WHERE clause is what makes this affordable. A sweep re-reads every
   * quiet conversation on every tick, so an unconditional UPDATE here would
   * add a write per conversation per tick — exactly the cost the early return
   * exists to avoid. Writing only when the verdict is new (`divergence_checked_at
   * IS NULL`) or has actually CHANGED means a steady state writes nothing, and
   * it needs no extra SELECT to decide.
   *
   * `IS DISTINCT FROM` rather than `<>`: the stored value is NULL for every row
   * predating this column, and `NULL <> '{}'` is NULL, not true — a plain
   * inequality would never match the rows that most need writing.
   *
   * Best-effort: this path's whole point is that there was nothing to ingest,
   * so a bookkeeping failure must not turn an idempotent no-op into an error.
   */
  private async persistDivergenceVerdict(
    agentSessionId: string,
    divergentTips: string[]
  ): Promise<void> {
    try {
      await this.db
        .update(agentTranscriptsTable)
        .set({ divergentTipLeaves: divergentTips, divergenceCheckedAt: new Date() })
        .where(
          and(
            eq(agentTranscriptsTable.agentSessionId, agentSessionId as ConversationId),
            // mt#3836: compare a canonical STRING, not the array itself.
            //
            // Interpolating a JS array into a `sql` template does NOT bind a
            // `text[]` — drizzle expands it into a comma-separated parameter
            // list, so this rendered `IS DISTINCT FROM ($4, $5)`, a row
            // constructor. Postgres rejects `text[] IS DISTINCT FROM record`,
            // the whole UPDATE threw, and the `catch` below swallowed it into a
            // warn — so this write never once succeeded from the day it
            // shipped. Joining to a string binds a single ordinary parameter
            // and sidesteps array binding entirely.
            //
            // NULL-safe by construction: `array_to_string(NULL, ',')` is NULL
            // and `NULL IS DISTINCT FROM '<anything>'` is TRUE, so a row that
            // has never been checked still matches. An empty verdict renders
            // `''` on BOTH sides — `array_to_string('{}', ',')` is the empty
            // string, not NULL — and correctly does not re-write. That case is
            // the one that would have hurt: a clean conversation re-writing on
            // every sweep tick is precisely the amplification this guard exists
            // to prevent, so it is asserted rather than assumed (PR #2708 R1,
            // integration test + a live re-ingest that left the timestamp
            // unchanged).
            //
            // Two couplings this comparison accepts, both safe for THIS data
            // and both worth knowing before reusing the shape (PR #2708 R1):
            // it is ORDER-sensitive, and the leaves are emitted in file order,
            // which is deterministic for an append-only transcript — a
            // reordering would cost one redundant write, never a wrong verdict;
            // and it is DELIMITER-coupled, which is sound only because the
            // values are uuids and cannot contain a comma.
            sql`(${agentTranscriptsTable.divergenceCheckedAt} IS NULL
              OR array_to_string(${agentTranscriptsTable.divergentTipLeaves}, ',')
                 IS DISTINCT FROM ${divergentTips.join(",")})`
          )
        );
    } catch (err) {
      log.warn(`Failed to record writer-divergence verdict for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
    }
  }

  private async recordIngestFailure(agentSessionId: string, cause: Error): Promise<void> {
    try {
      const summary = getLoggableErrorSummary(cause);
      // safeTruncate, not `.slice`: a plain slice can cut a UTF-16 surrogate
      // pair in half, and a lone surrogate is invalid UTF-8 — which Postgres
      // rejects. Truncating the error text unsafely could therefore fail the
      // very insert whose job is to record that something failed.
      const message = safeTruncate(
        sanitizeForPostgres(typeof summary === "string" ? summary : String(cause.message)),
        INGEST_ERROR_TEXT_LIMIT
      );

      await this.db
        .insert(agentTranscriptsTable)
        .values({
          agentSessionId: agentSessionId as ConversationId,
          harness: UNKNOWN_HARNESS,
          ingestFailureCount: 1,
          ingestLastError: message,
          ingestLastFailedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: agentTranscriptsTable.agentSessionId,
          set: {
            ingestFailureCount: sql`${agentTranscriptsTable.ingestFailureCount} + 1`,
            ingestLastError: message,
            ingestLastFailedAt: new Date(),
            // Quarantine on the threshold-th consecutive failure. Compares
            // against the PRE-increment stored value, hence `+ 1 >=`. Already
            // -quarantined rows keep their original timestamp (COALESCE) so the
            // record shows when the session was first given up on, not when it
            // was last looked at.
            ingestQuarantinedAt: sql`CASE WHEN ${agentTranscriptsTable.ingestFailureCount} + 1 >= ${INGEST_QUARANTINE_THRESHOLD} THEN COALESCE(${agentTranscriptsTable.ingestQuarantinedAt}, now()) ELSE ${agentTranscriptsTable.ingestQuarantinedAt} END`,
          },
        });
    } catch (err) {
      log.warn(`Failed to record ingest failure for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
    }
  }

  /**
   * Sweep all sessions discoverable by the source adapter and ingest each one.
   *
   * A failure on any individual session is logged and skipped so the sweep
   * continues over the remaining ~245 sessions.
   *
   * @returns Total number of new lines ingested across all sessions.
   */
  async ingestAll(): Promise<IngestAllResult> {
    let totalIngested = 0;
    let sessionsProcessed = 0;
    let sessionsErrored = 0;
    let sessionsQuarantined = 0;

    for await (const session of this.source.discoverSessions()) {
      sessionsProcessed++;
      try {
        const result = await this.ingestSession(session);
        totalIngested += result.ingested;
        if (result.quarantined === true) {
          // Not an error THIS pass — nothing was attempted. Counted separately
          // so an operator can tell "N sessions are failing right now" from
          // "N sessions have been given up on" (mt#3278).
          sessionsQuarantined++;
        } else if (result.error !== undefined) {
          // mt#3278 (SC3): this used to log at `warn` as a "degraded ingest",
          // which read like a partial success. An ingest that wrote nothing and
          // returned an error is a FAILED ingest — for a permanently-failing
          // session it means that conversation has silently stopped being
          // captured — so it is logged as one, at `error`, saying so.
          sessionsErrored++;
          log.error(`Ingest FAILED for session ${session.agentSessionId}`, {
            error: getLoggableErrorSummary(result.error),
            ingested: result.ingested,
          });
        }
      } catch (err) {
        // Defensive — ingestSession is documented as never throwing, but if
        // an unexpected throw escapes (e.g., an iterator boundary), still count it.
        sessionsErrored++;
        log.warn(`Session ${session.agentSessionId} failed during sweep`, {
          error: getLoggableErrorSummary(err),
        });
      }
    }

    log.info(`Ingest sweep complete`, {
      totalIngested,
      sessionsProcessed,
      sessionsErrored,
      sessionsQuarantined,
    });
    // mt#3278: a standing quarantine is an operator-visible condition, not a
    // per-sweep event, so it is surfaced every sweep rather than only on the
    // pass that created it — otherwise the one line announcing it scrolls away
    // and the sessions stay silently uncaptured.
    if (sessionsQuarantined > 0) {
      log.warn(
        `${sessionsQuarantined} session(s) are quarantined and were not attempted — see agent_transcripts.ingest_last_error`,
        { sessionsQuarantined }
      );
    }
    return { totalIngested, sessionsProcessed, sessionsErrored, sessionsQuarantined };
  }
}

export interface IngestSessionResult {
  /** Number of new lines written to agent_transcripts for this session. */
  ingested: number;
  /**
   * Set when ingestSession hit a failure along one of its internal paths.
   * HWM read / stream / upsert failures ABORT the ingest (mt#2789) and
   * return `{ ingested: 0, error }`; turn-extract / attachment-insert
   * failures are best-effort — the function continues and surfaces the
   * error on an otherwise-successful return. Either way, callers can count
   * it. mt#1444.
   */
  error?: Error;
  /**
   * True when this session was SKIPPED because it is quarantined (mt#3278) —
   * it failed to ingest {@link INGEST_QUARANTINE_THRESHOLD} times running, so
   * no attempt was made this pass.
   *
   * Deliberately distinct from `error`: a quarantined session is not an error
   * THIS pass, it is a standing condition an operator needs to see. Counting
   * it as an error would make the sweep's error count grow forever on a
   * session nobody is retrying, which is the same "indistinguishable from
   * normal" failure shape this task exists to remove.
   */
  quarantined?: boolean;
}

export interface IngestAllResult {
  totalIngested: number;
  sessionsProcessed: number;
  sessionsErrored: number;
  /**
   * Sessions SKIPPED this pass because they are quarantined (mt#3278). Disjoint
   * from `sessionsErrored` — a quarantined session was not attempted, so it
   * cannot also have failed. Both are counted within `sessionsProcessed`.
   */
  sessionsQuarantined: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the earliest ISO timestamp from the provided lines; returns null if
 * none of the lines carry a valid timestamp.
 */
function extractStartedAt(lines: RawTurnLine[], source: TranscriptSource): Date | null {
  let earliest: Date | null = null;
  for (const line of lines) {
    const tsStr = source.getJsonlTimestamp(line);
    if (!tsStr) continue;
    const d = new Date(tsStr);
    if (isNaN(d.getTime())) continue;
    if (earliest === null || d < earliest) {
      earliest = d;
    }
  }
  return earliest;
}

/**
 * Extract the first genuine (non-synthetic) model id from a batch of newly
 * ingested turn lines (mt#3089).
 *
 * Every REAL Claude Code transcript assistant line carries `message.model`
 * (e.g. `{"type":"assistant","message":{"model":"claude-sonnet-5",...}}`) —
 * the data has always been present in the JSONL; `agent_transcripts.model`
 * was simply never extracted from it (the ingest path never referenced the
 * `model` field at all prior to this fix, unlike the sibling `actual_model`
 * writer in `packages/domain/src/subagent/transcript-metrics.ts`'s
 * `extractActualModel`, mt#2796, which this mirrors). The harness also
 * injects `{@link SYNTHETIC_MODEL_SENTINEL}` on locally-manufactured retry
 * turns (rate-limit/API-error recovery) — never a genuine model response —
 * so those are skipped the same way `extractActualModel` skips them.
 *
 * Operates on the already-parsed `newLines` batch (not a re-read from disk):
 * `ingestSession` scans every retained line since the high-water-mark in one
 * pass, so for a session's FIRST ingest this batch includes its earliest
 * assistant turn and the model is found immediately. A later incremental
 * ingest's `newLines` may not re-include that early turn — the caller
 * (`ingestSession`) is responsible for not regressing an already-stored
 * value (COALESCE on conflict), not this pure extractor.
 *
 * Never throws — returns null on any unexpected shape.
 */
export function extractModelFromNewLines(lines: readonly RawTurnLine[]): string | null {
  for (const line of lines) {
    if (line.type !== "assistant") continue;
    try {
      const message = line.message as { model?: unknown } | undefined;
      const model = message?.model;
      if (typeof model === "string" && model.length > 0 && model !== SYNTHETIC_MODEL_SENTINEL) {
        return model;
      }
    } catch {
      // Defensive — line.message could theoretically be a getter that throws
      // on a malformed source adapter; never let extraction abort ingest.
      continue;
    }
  }
  return null;
}

/**
 * Count assistant-type lines in a batch (mt#3089 R1 review — extractor
 * observability).
 *
 * Used alongside {@link extractModelFromNewLines} to distinguish the two
 * shapes that both produce a `null` model result, which are NOT the same
 * situation:
 *
 *   - **0 assistant lines in the batch** — the common, unremarkable case (a
 *     batch of pure user/tool_result turns, or an incremental ingest whose
 *     new lines happen to be entirely non-assistant). Nothing to warn about.
 *   - **1+ assistant lines, but none carried a genuine (non-synthetic)
 *     `message.model`** — a genuine miss: either every assistant line in the
 *     batch was a synthetic retry, or the harness's transcript shape has
 *     drifted (e.g. `message.model` renamed/moved) and the extractor is
 *     silently failing to find data that should be there. Callers log this
 *     case — see `ingestSession`'s call site — so a future format drift
 *     reproduces as a visible, diagnosable log line instead of silently
 *     regressing back to the 0/1,729 state this task exists to fix.
 *
 * Exported (not just called inline) so both `ingestSession` and
 * `scripts/backfill-agent-transcripts-model.ts` share one definition instead
 * of duplicating the `type === "assistant"` filter.
 */
export function countAssistantLines(lines: readonly RawTurnLine[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.type === "assistant") count++;
  }
  return count;
}

/** Result of the missing-genuine-model warn decision (mt#3628, mt#3089 R1). */
export interface MissingModelWarnDecision {
  /** True when this batch should surface a "possible transcript-shape drift" warning. */
  shouldWarn: boolean;
}

/**
 * Pure decision core for the warn/no-warn split documented on
 * {@link countAssistantLines}: warn only when a batch has 1+ assistant lines
 * but NONE carried a genuine (non-synthetic) model — never when there are
 * simply no assistant lines to extract from. Extracted (mt#3628) so the
 * split is testable by return value alone, independent of `ingestSession`'s
 * DB/source orchestration.
 */
export function decideMissingModelWarn(
  extractedModel: string | null,
  assistantLineCount: number
): MissingModelWarnDecision {
  return { shouldWarn: extractedModel === null && assistantLineCount > 0 };
}

/**
 * Best-effort derivation of a project_dir from a JSONL path.
 *
 * Claude Code stores transcripts under `~/.claude/projects/<project-dir>/<session-uuid>.jsonl`.
 * The `project-dir` segment is the absolute project path with `/` replaced by `-`.
 * We return the parent directory of the JSONL file as a portable proxy.
 */
function deriveProjectDir(jsonlPath: string): string {
  const lastSlash = jsonlPath.lastIndexOf("/");
  return lastSlash > 0 ? jsonlPath.slice(0, lastSlash) : jsonlPath;
}
