/**
 * Shared Calibration Commands (mt#2483)
 *
 * Exposes the hook-calibration review sweep as both CLI and MCP surfaces via
 * the shared command registry. The `observability.calibration-review` command:
 *
 *   - Reads from a registry of known hook-calibration JSONL logs (NOT a single
 *     hardcoded path — adding a third log is a one-line registry change in
 *     `calibration-sweep.ts`).
 *   - Returns per-log: total fires, fires-since-last-review, diversity signal,
 *     and matched records past the watermark.
 *   - Defaults to read-only reporting; only advances the watermark when
 *     --ack / --mark-reviewed is passed (operational-safety dry-run-first,
 *     per CLAUDE.md).
 *   - The pure sweep logic lives in `src/domain/calibration/calibration-sweep.ts`
 *     (unit-testable, no filesystem I/O).
 *
 * Watermark persistence: `.minsky/calibration-review-watermarks.json` (keyed
 * by log path → { lastReviewedCount, lastReviewedAt }).
 *
 * @see mt#2483 — tracking task
 * @see src/domain/calibration/calibration-sweep.ts — pure logic
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
} from "../command-registry";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { resolveCallerActorId } from "@minsky/domain/agent-identity/index";
import { buildSweptEntries } from "../../../domain/calibration/swept-entries";
import {
  blockingClaims,
  describeBlockingClaims,
  logsToActOn,
  pruneStaleClaims,
  releaseClaims,
  withClaims,
  type CalibrationClaimStore,
} from "../../../domain/calibration/calibration-claims";
import {
  runSweep,
  computeReviewDueLogs,
  advanceWatermarks,
  buildReviewToken,
  clearResolvedAskIds,
  InvalidReviewTokenError,
  mergeWatermarkWrite,
  parseReviewToken,
  reconcileReviewReceipt,
  selectAckablePaths,
  UNKNOWN_SILENT_STRETCH_SESSION_LABEL,
  type CalibrationLogResult,
  type CalibrationRecord,
  type ReviewDueLog,
  type WatermarkStore,
} from "../../../domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Watermark store path (repo-relative)
// ---------------------------------------------------------------------------

const WATERMARK_STORE_PATH = ".minsky/calibration-review-watermarks.json";

/**
 * Lock guarding the watermark store's read-merge-write critical section
 * (mt#3899). A directory, because `mkdir` is atomic and exclusive on every
 * platform we run on — no dependency, no partial-create state.
 */
const WATERMARK_LOCK_PATH = ".minsky/calibration-review-watermarks.lock";
/** A holder older than this is treated as dead; the section is ~2 file ops. */
const WATERMARK_LOCK_STALE_MS = 10_000;
/** Give up waiting and proceed unlocked rather than lose the pass's work. */
const WATERMARK_LOCK_MAX_WAIT_MS = 5_000;
const WATERMARK_LOCK_RETRY_MS = 15;

// ---------------------------------------------------------------------------
// Per-record context rendering (mt#3289)
// ---------------------------------------------------------------------------

/** Indent for context lines nested under a record's summary line. */
const RECORD_CONTEXT_INDENT = "      ";

/** Longest detector-specific string rendered under a record. */
const CONTEXT_PREVIEW_CHARS = 300;

/**
 * Values at or below this length ride on one shared line instead of their own.
 */
const CONTEXT_INLINE_CHARS = 60;

function previewText(value: string): string {
  return value.length <= CONTEXT_PREVIEW_CHARS
    ? value
    : `${value.slice(0, CONTEXT_PREVIEW_CHARS)}...`;
}

/**
 * Render detector-specific fields the shared fallback branch used to drop.
 *
 * The long-string case is the reason this exists: `untaken-action`'s
 * `final_message_tail` is the only field that makes its fires classifiable, and
 * it sat on disk in every record since the first while two consecutive
 * calibration reviews reported "unclassifiable" — because nothing downstream
 * printed it. Short scalars ride along on one line since they are the
 * suppression/channel context needed to read the excerpt correctly.
 */
function formatDetectorFields(fields: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  const inline: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.length > CONTEXT_INLINE_CHARS) {
      lines.push(`${indent}${key}: ${JSON.stringify(previewText(value))}`);
    } else {
      inline.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  if (inline.length > 0) lines.unshift(`${indent}${inline.join(" ")}`);
  return lines;
}

/**
 * Context lines rendered beneath a record's summary line (mt#3289).
 *
 * The acceptance bar is that a reviewer can compute an FP rate for a fresh
 * batch without opening transcripts or detector source. That needs the
 * surrounding text PRINTED, not merely parsed.
 */
function buildRecordContextLines(rec: CalibrationRecord): string[] {
  const lines: string[] = [];
  if ("transcript_excerpt" in rec && rec.transcript_excerpt) {
    lines.push(
      `${RECORD_CONTEXT_INDENT}excerpt: ${JSON.stringify(previewText(rec.transcript_excerpt))}`
    );
  }
  if (rec.detectorFields) {
    lines.push(...formatDetectorFields(rec.detectorFields, RECORD_CONTEXT_INDENT));
  }
  if ("matches" in rec) {
    for (const m of rec.matches) {
      if (m.detectorFields) {
        lines.push(...formatDetectorFields(m.detectorFields, `${RECORD_CONTEXT_INDENT}  `));
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (isolated here so the pure logic stays testable)
// ---------------------------------------------------------------------------

function resolveWorkspacePath(ctx?: CommandExecutionContext): string {
  // Prefer the workspace resolved by the execution context (correct for MCP /
  // session-scoped invocations where the server cwd is not the user's workspace);
  // fall back to cwd for plain CLI use. The calibration logs are repo-relative.
  return ctx?.workspacePath ?? process.cwd();
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import("node:fs");
    return String(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function writeFileMkdir(filePath: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

async function loadWatermarks(workspacePath: string): Promise<WatermarkStore> {
  const { join } = await import("node:path");
  const storePath = join(workspacePath, WATERMARK_STORE_PATH);
  const content = await readFileOrNull(storePath);
  if (!content) return {};
  try {
    return JSON.parse(content) as WatermarkStore;
  } catch {
    return {};
  }
}

async function saveWatermarks(workspacePath: string, store: WatermarkStore): Promise<void> {
  const { join } = await import("node:path");
  const storePath = join(workspacePath, WATERMARK_STORE_PATH);
  await writeFileMkdir(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * Sweep-time claim store (mt#4164), a sibling of the watermark store and guarded
 * by the SAME lock — the two are written in one critical section, so a pass can
 * never take a claim it then fails to record, or release one whose ack was lost.
 */
const CLAIM_STORE_PATH = ".minsky/calibration-review-claims.json";

async function loadClaims(workspacePath: string): Promise<CalibrationClaimStore> {
  const { join } = await import("node:path");
  const content = await readFileOrNull(join(workspacePath, CLAIM_STORE_PATH));
  if (!content) return {};
  try {
    return JSON.parse(content) as CalibrationClaimStore;
  } catch {
    // Same posture as the watermark store: an unreadable file degrades to "no
    // claims" rather than blocking every pass on a corrupt one.
    return {};
  }
}

async function saveClaims(workspacePath: string, store: CalibrationClaimStore): Promise<void> {
  const { join } = await import("node:path");
  await writeFileMkdir(
    join(workspacePath, CLAIM_STORE_PATH),
    `${JSON.stringify(store, null, 2)}\n`
  );
}

/**
 * This pass's actor identity, or null when the runtime cannot supply one.
 *
 * The resolution itself (server-injected first, then harness env) moved to
 * `resolveCallerActorId` in mt#4568, because `tasks.claims.release` needs the
 * identical rule and a second copy of an identity rule is exactly the failure
 * this resolution exists to end. Its docblock carries the mt#4408 measurement.
 *
 * The CALIBRATION-specific consequence stays here: null is a real outcome
 * rather than a fallback to an invented id — a claim whose holder cannot be
 * named is worse than no claim, since a second pass would see it, stand down,
 * and have nobody to attribute the work to. So an unidentifiable pass FAILS
 * OPEN (claims nothing, blocks nobody) and says so in the result.
 */
const resolveActorId = resolveCallerActorId;

/**
 * Run `critical` with exclusive access to the watermark store (mt#3899).
 *
 * Re-reading before writing narrows the race but does not close it: another
 * pass can still write in the gap between this pass's re-read and its own
 * write. That gap is small — two file operations — but it is exactly where two
 * in-process passes land, and it is where the originating incident's write
 * would have landed too. The lock makes read-merge-write indivisible.
 *
 * **Failure mode, stated because a lock has one.** The lock is a directory, so
 * a process that dies mid-section leaves it behind. Two bounds keep that from
 * wedging the loop: a holder older than `WATERMARK_LOCK_STALE_MS` is removed as
 * dead, and a waiter that has spun for `WATERMARK_LOCK_MAX_WAIT_MS` proceeds
 * WITHOUT the lock rather than failing. Proceeding unlocked degrades to
 * re-read-and-merge — the narrow race — which is strictly better than throwing
 * away a pass's classification work over a stale directory. The section holds
 * the lock for two file ops, never for the multi-second sweep, so contention is
 * brief by construction.
 */
async function withWatermarkLock<T>(workspacePath: string, critical: () => Promise<T>): Promise<T> {
  const { join } = await import("node:path");
  const { mkdir, rm, stat } = await import("node:fs/promises");
  const lockPath = join(workspacePath, WATERMARK_LOCK_PATH);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const deadline = Date.now() + WATERMARK_LOCK_MAX_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath, { recursive: false });
      held = true;
      break;
    } catch {
      // Held by someone. Reap it if the holder looks dead, then retry.
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > WATERMARK_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Vanished between the failed mkdir and the stat — the holder released
        // it, so retry immediately rather than sleeping.
        continue;
      }
      await sleep(WATERMARK_LOCK_RETRY_MS);
    }
  }

  try {
    return await critical();
  } finally {
    if (held) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {
        // intentional-swallow: releasing a lock we hold is best-effort. A
        // failure here leaves a directory the staleness reaper collects; it
        // must not mask the critical section's own result or error.
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/**
 * Render the sweep for a human reader.
 *
 * Exported for direct testing (mt#3898 / PR #2884 R1). Nothing covered this
 * surface, which is why a property present in the JSON could go missing from
 * the text with every check green — the reviewer caught exactly that here, and
 * PR #2599 R1 had caught the same class one property earlier. A formatter whose
 * only verification is a reviewer's eye keeps re-losing fields.
 */
export function formatResult(results: CalibrationLogResult[], reviewDue: ReviewDueLog[]): string {
  const lines: string[] = ["=== Calibration Review Sweep ===", ""];
  const reasonByPath = new Map(reviewDue.map((d) => [d.path, d.reason]));

  for (const r of results) {
    lines.push(`Log: ${r.entry.name} (${r.entry.path})`);
    lines.push(`  Exists:                 ${r.exists}`);
    lines.push(`  Total fires (all-time): ${r.totalFires}`);
    lines.push(`  Watermark count:        ${r.watermarkCount}`);
    lines.push(`  Fires since review:     ${r.firesSinceLastReview}`);
    // mt#3197: the positional count above includes detections that were
    // suppressed before reaching the operator. mt#3863 widens the split with
    // evaluation-only records — a record carrying no match at all, from a
    // detector that logs on every turn regardless of outcome. Show all three
    // so a reviewer never mistakes log volume (or evaluation volume) for
    // attention cost.
    if (r.suppressedSinceLastReview > 0 || r.evaluatedOnlySinceLastReview > 0) {
      if (r.suppressedSinceLastReview > 0) {
        lines.push(`    ...suppressed:        ${r.suppressedSinceLastReview} (never injected)`);
      }
      if (r.evaluatedOnlySinceLastReview > 0) {
        lines.push(
          `    ...evaluated-only:    ${r.evaluatedOnlySinceLastReview} (no match, mt#3863)`
        );
      }
      lines.push(`    ...injected:          ${r.injectedFiresSinceLastReview}`);
    }
    lines.push(`  Distinct phrases:       ${r.distinctPhrases}`);
    lines.push(`  At count threshold:     ${r.atCountThreshold}`);
    lines.push(`  Past threshold:         ${r.pastThreshold}`);
    const dueReason = reasonByPath.get(r.entry.path);
    if (dueReason) {
      lines.push(`  Review-due:             ${dueReason}`);
    }
    if (r.openAskId) {
      lines.push(`  Open ask (mt#2659):     ${r.openAskId} — disposition pending`);
    }
    if (r.lowDiversity) {
      lines.push(`  ⚠  Low diversity (count bar hit but < 3 distinct phrases) — keep collecting`);
    }
    // mt#3610: the tool's own verdict on whether these fires can be rated, so a
    // "cannot classify" disposition has to contradict something rather than pass
    // unchallenged. Evidence fields print WITH their level (`detectorFields.x`
    // vs a bare top-level key) — conflating those two levels is exactly what
    // produced the mt#3576 misread this exists to catch.
    const classifiability = r.classifiability;
    if (classifiability.verdict === "classifiable") {
      lines.push(
        `  Classifiable:           yes — ${classifiability.recordsAssessed} record(s) carry: ${classifiability.evidenceFields.join(", ")}`
      );
    } else if (classifiability.verdict === "not-classifiable") {
      lines.push(
        `  Classifiable:           NO — ${classifiability.recordsAssessed} record(s), none carrying any evidence field`
      );
    } else {
      // PR #2599 R1: print `no-records` too. Omitting it made the text surface
      // disagree with the JSON one, which carries the verdict unconditionally —
      // and a reader of the text would see nothing where the tool has an
      // opinion. "Nothing has fired" is a different statement from "the fires
      // cannot be rated," which is why the verdict distinguishes them at all;
      // showing only two of three states re-hides that distinction.
      lines.push(`  Classifiable:           n/a — no un-reviewed records to assess`);
    }
    // mt#3898 / PR #2884 R1: render the recoverability signal too. Same class
    // as the PR #2599 R1 fix directly above — a property the JSON carries and
    // the text omits is a property the reader of the text does not have. It
    // matters more here than for the verdict: the whole point of the property
    // is that `classifiable` alone misleads, so printing the verdict WITHOUT
    // it reproduces the gap this shipped to close.
    const judged = classifiability.judgedText;
    if (judged.recoverability === "recoverable") {
      lines.push(`  Judged text:            recoverable — all ${judged.recordsAssessed} record(s)`);
    } else if (judged.recoverability === "partial") {
      // mt#4465: bound the rate to the RECOVERABLE records, not the
      // marker-carrying ones. Those were the same number while recoverability
      // derived from the marker alone; they are not any more, and this line is
      // the one a reviewer acts on.
      lines.push(
        `  Judged text:            PARTIAL — ${judged.recoverableRecords} of ${judged.recordsAssessed} record(s); bound any rate to the recoverable ones`
      );
    } else if (judged.recoverability === "unrecoverable") {
      // "carry no capture" was the pre-mt#4465 wording and it states the very
      // conflation this shipped to remove: capture-marker absence is NOT
      // unrecoverability. Say what was actually checked — no marker AND no
      // mapped judged-text field — so the line a reviewer acts on stops
      // implying the marker is the only thing that counts. (PR #3432 R1)
      lines.push(
        `  Judged text:            GONE — ${judged.recordsAssessed} record(s) carry neither a capture marker nor readable judged text; you can rate what matched, not whether it was right in context`
      );
      // mt#4465 SC4: distinguish "the text is gone" from "the sweep has no
      // mapping for this detector". Both render GONE above, and only the second
      // is fixable by adding a line to `JUDGED_TEXT_FIELDS` — so a NEW detector
      // that writes judged text under its own key says so here instead of
      // looking identical to a log whose text really is unrecoverable.
      if (judged.unmappedDetector) {
        lines.push(
          `                          ...and no judged-text field is mapped for "${judged.unmappedDetector}" — this GONE may be the map, not the data`
        );
      }
    } else {
      lines.push(`  Judged text:            n/a — no un-reviewed records to assess`);
    }
    if (r.atCountThreshold && r.newRecords.length > 0) {
      lines.push(`  New records (${r.newRecords.length}):`);
      for (const rec of r.newRecords.slice(0, 5)) {
        if ("matchedPhrases" in rec) {
          lines.push(
            `    [${rec.timestamp}] phrases: ${rec.matchedPhrases.slice(0, 3).join(", ")}`
          );
        } else if ("claims" in rec) {
          lines.push(
            `    [${rec.timestamp}] claims: ${rec.claims
              .slice(0, 3)
              .map((c) => `${c.symbol}:${c.predicate}`)
              .join(", ")}`
          );
        } else if ("reason" in rec) {
          lines.push(`    [${rec.timestamp}] outcome=${rec.outcome} reason=${rec.reason}`);
        } else if ("gapMinutes" in rec) {
          lines.push(
            `    [${rec.timestamp}] gap=${rec.gapMinutes}min toolCalls=${rec.toolCallCount} ` +
              `conversation=${rec.session_id ?? UNKNOWN_SILENT_STRETCH_SESSION_LABEL}`
          );
        } else if ("wordCount" in rec) {
          lines.push(
            `    [${rec.timestamp}] words=${rec.wordCount} trigger=${rec.trigger}` +
              `${rec.leadLabelHits && rec.leadLabelHits.length > 0 ? ` labels=${rec.leadLabelHits.join("+")}` : ""} ` +
              `conversation=${rec.session_id ?? UNKNOWN_SILENT_STRETCH_SESSION_LABEL}`
          );
        } else if ("loadedSkills" in rec) {
          lines.push(
            `    [${rec.timestamp}] rung=${rec.detectionRung} skills=${rec.loadedSkills.slice(0, 3).join(", ")} ` +
              `tools=${rec.researchTools.slice(0, 3).join(", ")} hadPropagation=${rec.hadPropagation}`
          );
        } else if ("targets" in rec) {
          // stop-at-decision (mt#3653): render the target task ids + statuses,
          // the record's diversity axis. Structural (`"targets" in rec`)
          // discrimination matches every sibling branch in this chain and in
          // calibration-sweep's extractDistinctPhrases — the union is
          // discriminated by field shape, not by kind, so a future record
          // kind adding a `targets` field must pick a different field name or
          // convert this whole chain to kind-tagged parsing (PR #2611 R1
          // noted the collision risk; changing only this branch would not
          // remove it).
          lines.push(
            `    [${rec.timestamp}] targets: ${rec.targets
              .slice(0, 3)
              .map((t) => `${t.taskId}:${t.status}`)
              .join(", ")}`
          );
        } else {
          lines.push(
            `    [${rec.timestamp}] families: ${rec.matches
              .slice(0, 3)
              .map((m) => `${m.family}:${m.phrase.slice(0, 40)}`)
              .join(", ")}`
          );
        }
        lines.push(...buildRecordContextLines(rec));
      }
      if (r.newRecords.length > 5) {
        lines.push(`    ... and ${r.newRecords.length - 5} more`);
      }
    }
    lines.push("");
  }

  if (reviewDue.length === 0) {
    lines.push("No logs are review-due.");
  } else {
    lines.push(`${reviewDue.length} log(s) review-due:`);
    for (const d of reviewDue) {
      lines.push(
        `  - ${d.name}: ${d.reason} (${d.firesSinceLastReview} new / ${d.totalFires} total fires)`
      );
    }
    lines.push(
      `Re-run with --ack to advance watermarks for the ${reviewDue.length} review-due log(s) after review.`
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Register all calibration commands in the shared command registry. */
export function registerCalibrationCommands(): void {
  sharedCommandRegistry.registerCommand({
    id: "observability.calibration-review",
    category: CommandCategory.OBSERVABILITY,
    name: "calibration-review",
    description:
      "Review hook-calibration JSONL logs: count fires, check diversity threshold, and return unreviewed records. " +
      "Read-only by default; pass --ack to advance watermarks after inspection.",
    requiresSetup: false,
    parameters: {
      ack: {
        schema: z.boolean(),
        description:
          "Advance the watermark for every review-due log — any reason: past-threshold, " +
          "time-stale, never-reviewed or never-fired — marking them as reviewed (mt#2878). " +
          "Without this flag the command is read-only.",
        required: false,
        defaultValue: false,
      },
      json: {
        schema: z.boolean(),
        description: "Output results as JSON instead of human-readable text.",
        required: false,
        defaultValue: false,
      },
      reviewToken: {
        schema: z.string(),
        description:
          "The `reviewToken` returned by the READ-ONLY sweep whose records you classified " +
          "(mt#3906). REQUIRED with ack:true. It carries the per-log fire counts as of that " +
          "read, so the watermark records what was actually reviewed instead of whatever the " +
          "log has grown to by ack time — records that arrive mid-pass stay unreviewed and " +
          "are reported as `midPassArrivals` rather than silently marked seen. A token that " +
          "is malformed, or that claims more records than the log holds, is REJECTED (no " +
          "watermark moves); one whose count sits below an existing watermark is raised to it.",
        required: false,
      },
      askId: {
        schema: z.string(),
        description:
          "ID of the disposition Ask just filed for the review-due logs in this pass " +
          "(mt#2659). Only meaningful together with ack:true — recorded as `openAskId` on " +
          "every watermark advanced by this call so the cadence-detector hook suppresses its " +
          "per-turn warning for these logs until the ask is resolved. A review-due log " +
          "whose watermark ALREADY carries a DIFFERENT `openAskId` and for which this param is " +
          "NOT supplied is skipped by --ack (see `skippedOpenAskPaths` in the result) rather " +
          "than silently advanced — per the /calibration-review skill's Step 1a, a log with a " +
          "still-open disposition ask must not be re-classified or re-acked until that ask " +
          "resolves (via `clearAskId`).",
        required: false,
      },
      clearAskId: {
        schema: z.string(),
        description:
          "Ask ID to clear from any watermark's `openAskId` field (mt#2659). Pass it once " +
          "`asks_list` confirms a previously-filed disposition ask has reached a terminal " +
          "state (responded/closed/cancelled/expired) — clearing resumes the cadence " +
          "detector's normal per-turn warning for the affected log(s). Independent of ack; " +
          "applied before the sweep result is computed. Single ask ID (not an array) because " +
          "one /calibration-review pass files exactly ONE ask covering all review-due logs " +
          "in that pass, so exactly one id is ever cleared at a time in practice — this also " +
          "sidesteps CLI array-flag delimiter ambiguity (comma-split vs repeatable flag) that " +
          "the shared command-registry's CLI bridge does not currently resolve for array-typed " +
          "Zod schemas.",
        required: false,
      },
      callerActorId: {
        schema: z.string(),
        description:
          "mt#4408: the caller's resolved agentId (ADR-006), used as the holder of this " +
          "pass's concurrency claim on each review-due log. Server-injected from the " +
          "resolved MCP identity (src/mcp/server.ts) — not normally supplied by hand, and " +
          "any hand-supplied value is overwritten there. Absent on the CLI path, which " +
          "resolves identity from the harness environment instead. Without it, an " +
          "MCP-invoked pass has no identity at all (the MCP server is a long-lived daemon " +
          "that never carries a conversation's env vars), so it claims nothing and a " +
          "concurrent pass gets no warning — the mt#4408 R4 collision.",
        required: false,
        // Server-injected only — hide it from the CLI surface so it is not
        // advertised as a hand-passable flag (mirrors tasks.dispatch-recover).
        cliHidden: true,
        // Server-injected on the MCP path too, so do not advertise it there
        // either (mt#4579) — the server overwrites any supplied value.
        mcpHidden: true,
      },
    },
    async execute(params, ctx) {
      try {
        const workspacePath = resolveWorkspacePath(ctx);
        const { join } = await import("node:path");

        // Build the reader function (resolves repo-relative paths)
        const readContent = async (relPath: string): Promise<string | null> => {
          return readFileOrNull(join(workspacePath, relPath));
        };

        let watermarks = await loadWatermarks(workspacePath);

        // Every write below goes through `persistWatermarks` (mt#3899), which
        // re-reads the store and drops any target another pass changed
        // underneath us. Drifted paths accumulate here and are reported.
        const driftedPaths: string[] = [];

        /**
         * Persist `intended` against the store as it stands NOW, not against
         * the snapshot this pass read (mt#3899). Returns the paths whose edit
         * was dropped because a concurrent writer got there first; the caller
         * decides what that means for its own success flag.
         */
        const persistWatermarks = async (
          base: WatermarkStore,
          intended: WatermarkStore,
          targetPaths: ReadonlySet<string>
        ): Promise<{ store: WatermarkStore; drifted: string[] }> =>
          // The re-read and the write must be indivisible: re-reading alone
          // still loses to a writer that lands in between, which is where two
          // in-process passes reliably collide (measured — the AT1 test failed
          // against the re-read-only version of this fix).
          withWatermarkLock(workspacePath, async () => {
            const fresh = await loadWatermarks(workspacePath);
            const { merged, driftedPaths: drifted } = mergeWatermarkWrite(
              base,
              intended,
              fresh,
              targetPaths
            );
            await saveWatermarks(workspacePath, merged);
            driftedPaths.push(...drifted);
            return { store: merged, drifted };
          });

        // Clear a resolved disposition-ask reference first (mt#2659) — this
        // is independent of --ack and does not touch lastReviewedCount/At.
        let clearedAskId = false;
        if (params.clearAskId) {
          // Select the entries FIRST, and gate on that rather than on
          // `clearResolvedAskIds`'s return reference: it copies the store
          // whenever the id set is non-empty, so reference-inequality holds even
          // when the id matches no entry — which would otherwise read+write the
          // whole store to change nothing (PR #2753 R1).
          const targets = new Set(
            Object.keys(watermarks).filter((p) => watermarks[p]?.openAskId === params.clearAskId)
          );
          if (targets.size > 0) {
            const clearedWatermarks = clearResolvedAskIds(watermarks, new Set([params.clearAskId]));
            const { store, drifted } = await persistWatermarks(
              watermarks,
              clearedWatermarks,
              targets
            );
            watermarks = store;
            // Honest reporting: a clear whose every target drifted cleared
            // nothing, so it must not claim it did.
            clearedAskId = drifted.length < targets.size;
          }
        }

        // mt#3716: sweep the DERIVED set when the declaration surfaces are
        // reachable (see buildSweptEntries's doc comment); falls back to the
        // static registry otherwise.
        const sweptEntries = await buildSweptEntries();
        const results = await runSweep(sweptEntries, readContent, watermarks);

        // Review-due determination (mt#2896) — the SAME domain function the
        // cadence hook uses, so the command surfaces time-stale / never-reviewed
        // logs, not only pastThreshold. `--ack` below advances exactly this set
        // (mt#2878), so what an operator can discharge is BY CONSTRUCTION what
        // the cadence hook warns about.
        const reviewDueAll = computeReviewDueLogs(results, watermarks, Date.now());

        // Sweep-time claims (mt#4164). Taken BEFORE the caller classifies
        // anything, because classification is the expensive part and it is
        // entirely upstream of any artifact a prose probe could have found —
        // which is why that probe failed three times (R1/R2/R3).
        //
        // Read-merge-write under the watermark lock so a claim and the watermark
        // it will later advance can never disagree.
        const actorId = resolveActorId(params.callerActorId);
        let claimedByOthers: string[] = [];
        await withWatermarkLock(workspacePath, async () => {
          const nowMs = Date.now();
          // Pruning runs even for an unidentifiable pass (PR #3015 R1): it needs
          // no actor id, and it is what keeps a dead holder's claim from
          // outliving its staleness window in the file. An ack therefore always
          // leaves the store tidy, which is what SC4 asks for.
          const store = pruneStaleClaims(await loadClaims(workspacePath), nowMs);
          const paths = reviewDueAll.map((d) => d.path);

          // READ first, and unconditionally (mt#4408). An unidentifiable pass
          // cannot name ITSELF, which is why it must not WRITE a claim — but it
          // can still be told that someone ELSE holds a log, and that costs
          // nothing and blocks nobody. Before this, the `!actorId` early return
          // sat above this line and skipped the read too, so such a pass
          // reported `claimedByOthers: []` having never consulted the store —
          // an absence in a derived view presented as an observation. `null`
          // excludes nothing from `blockingClaims`, which is correct here: a
          // pass with no identity holds no claims to exclude as its own.
          const blocked = blockingClaims(store, paths, actorId, nowMs);
          claimedByOthers = blocked.map((c) => c.logPath);

          // WRITE only when identity is known. Failing open on this side is
          // deliberate and unchanged — see `resolveActorId`'s docblock.
          if (!actorId) {
            await saveClaims(workspacePath, store);
            return;
          }

          // Claim only what this pass will actually work on. Claiming a log
          // another pass holds would overwrite its holder and defeat the
          // mechanism.
          const mine = paths.filter((p) => !claimedByOthers.includes(p));
          const next = params.ack
            ? // The ack is the END of a pass: release what this actor held
              // rather than re-claiming it for a pass that is finishing.
              releaseClaims(store, paths, actorId)
            : withClaims(store, mine, actorId, new Date(nowMs).toISOString());
          await saveClaims(workspacePath, next);
        });

        // A log another pass is actively classifying is dropped from THIS pass's
        // review-due set — standing down means not classifying it.
        //
        // **The ack path is deliberately NOT filtered** (PR #3015 R1). A claim
        // answers "who is WORKING"; the receipt answers "what was READ", and
        // this task's own `## Scope` separates them precisely so they cannot be
        // conflated. Filtering the ack set by concurrent claims conflates them:
        // a pass that legitimately classified a log would be unable to record
        // that fact because someone ELSE started working on it in the interim,
        // silently discarding real review work. The receipt already bounds what
        // an ack may advance (mt#3906), and `selectAckablePaths` plus the
        // drift check (mt#3899) bound it further — the claim adds nothing there
        // and only takes away.
        const reviewDue = logsToActOn(reviewDueAll, claimedByOthers, params.ack === true, (d) =>
          String(d.path)
        );

        // Advance watermarks for review-due logs when --ack is set.
        //
        // mt#2878: this path used to re-derive its own, narrower selection
        // (`results.filter((r) => r.pastThreshold)`) rather than consuming the
        // `reviewDue` set computed just above. `computeReviewDueLogs` has FOUR
        // legs — past-threshold, time-stale, never-reviewed (mt#2896) and
        // never-fired (mt#3078) — and only the first was ackable, so a log
        // flagged by any other leg could be reviewed but never MARKED reviewed.
        // The cadence hook then re-warned on it every turn with no operator
        // action able to stop it: `pre-narration` sat time-stale-and-unackable
        // for 19 days, and `causal-premise` (never-reviewed, 3 fires against a
        // count bar of 10) could not have been discharged at all. Selecting from
        // `reviewDue` keeps the warn-set and the discharge-set aligned by
        // construction instead of by two filters happening to agree.
        //
        // This strictly WIDENS the previous behavior rather than narrowing it:
        // `computeReviewDueLogs` pushes every `pastThreshold` log before testing
        // any other leg, so nothing that used to be ackable stops being so.
        //
        // mt#2659 review fix (BLOCKING 2): a review-due log whose watermark
        // ALREADY carries an `openAskId` must NOT be silently re-acked when this
        // call doesn't also supply `askId` — per the /calibration-review skill's
        // Step 1a, a log with a still-open disposition ask is skipped entirely
        // (no re-classification, no re-ack) until the ask resolves via
        // `clearAskId`. Advancing its watermark anyway would falsely mark THIS
        // batch of fires as "reviewed" even though nobody looked at them — the
        // operator's outstanding decision covers an earlier snapshot, not
        // whatever accumulated since. When `askId` IS supplied, the caller is
        // explicitly (re)affirming an ask for every review-due log this
        // call, so no log is skipped on that basis.
        // mt#3906: the token the READ-ONLY sweep issued is what makes the ack
        // honest. Issued on every invocation (including this one) so a pass
        // always leaves with a receipt for its next round.
        // The token records BOTH what this sweep counted and which logs it
        // PRESENTED as due (mt#4391). `reviewDue` is the claim-filtered set the
        // caller is actually shown above, so the receipt and the reviewer's view
        // are the same thing by construction rather than by two computations
        // agreeing.
        const reviewToken = buildReviewToken(
          results,
          new Date().toISOString(),
          reviewDue.map((d) => String(d.path)),
          // Recorded separately, NOT folded into `reviewDue` (PR #3214 R1). A
          // claim-held log must not be advanced — this pass stood down on it —
          // but calling it "newly due" later would assert a threshold crossing
          // that never happened. Minting `reviewDue` from the UNFILTERED set
          // instead would fix the label by advancing logs nobody classified,
          // which is the defect this task exists to close.
          claimedByOthers
        );

        let watermarkAdvanced = false;
        let skippedOpenAskPaths: string[] = [];
        let midPassArrivals: { path: string; count: number }[] = [];
        let clampedPaths: string[] = [];
        let unreceiptedPaths: string[] = [];
        let newlyDuePaths: string[] = [];
        let claimHeldPaths: string[] = [];
        let ackedByAnotherPass: string[] = [];
        if (params.ack) {
          // Refuse rather than fall back. An ack with no receipt cannot know
          // what was classified, and re-deriving the count here is the whole
          // defect (mt#3906) — so the answer is a one-call remedy, not a
          // silent write over records nobody looked at.
          if (!params.reviewToken) {
            return {
              success: false,
              json: params.json ?? false,
              error:
                "ack:true requires reviewToken — the token returned by the read-only sweep whose " +
                "records you classified (mt#3906). Without it the watermark would be advanced to " +
                "the log's count RIGHT NOW, marking every record that arrived during your review " +
                "as reviewed by nobody. Re-run this command read-only and pass the `reviewToken` " +
                "from its result.",
            };
          }
          const reviewDuePaths = new Set(reviewDue.map((d) => d.path));
          const reviewDueResults = results.filter((r) => reviewDuePaths.has(r.entry.path));
          const selection = selectAckablePaths(reviewDueResults, params.askId);
          skippedOpenAskPaths = selection.skippedOpenAskPaths;

          let reconciliation;
          try {
            reconciliation = reconcileReviewReceipt(
              parseReviewToken(params.reviewToken),
              results,
              selection.ackablePaths,
              watermarks
            );
          } catch (error) {
            if (error instanceof InvalidReviewTokenError) {
              return { success: false, json: params.json ?? false, error: error.message };
            }
            throw error;
          }
          midPassArrivals = reconciliation.midPassArrivals;
          clampedPaths = reconciliation.clampedPaths;
          unreceiptedPaths = reconciliation.unreceiptedPaths;
          newlyDuePaths = reconciliation.newlyDuePaths;
          claimHeldPaths = reconciliation.claimHeldPaths;
          ackedByAnotherPass = reconciliation.ackedByAnotherPass;

          // Target only the paths the receipt actually covers: an unreceipted
          // log is left alone, so it must not count toward the write set or
          // toward `watermarkAdvanced`.
          const advancedPaths = new Set(Object.keys(reconciliation.reviewedCounts));
          if (advancedPaths.size > 0) {
            const updated = advanceWatermarks(
              watermarks,
              results,
              // The EXACT set we intend to write, not the broader
              // `selection.ackablePaths` (PR #3214 R1). Behaviour is identical
              // today — `advanceWatermarks` also skips any path missing from
              // `reviewedCounts` — but that made the write target depend on an
              // invariant held in another function, and left the set handed to
              // it wider than the one `watermarkAdvanced` is computed against.
              advancedPaths,
              new Date().toISOString(),
              reconciliation.reviewedCounts,
              params.askId
            );
            const { drifted } = await persistWatermarks(watermarks, updated, advancedPaths);
            // An ack whose every target drifted advanced nothing. Reporting it
            // as advanced is what makes the race silent (mt#3899).
            watermarkAdvanced = drifted.length < advancedPaths.size;
          }
        }

        if (params.json) {
          return {
            success: true,
            json: true,
            results: results.map((r) => ({
              name: r.entry.name,
              path: r.entry.path,
              exists: r.exists,
              totalFires: r.totalFires,
              watermarkCount: r.watermarkCount,
              firesSinceLastReview: r.firesSinceLastReview,
              suppressedSinceLastReview: r.suppressedSinceLastReview,
              injectedFiresSinceLastReview: r.injectedFiresSinceLastReview,
              evaluatedOnlySinceLastReview: r.evaluatedOnlySinceLastReview,
              distinctPhrases: r.distinctPhrases,
              atCountThreshold: r.atCountThreshold,
              lowDiversity: r.lowDiversity,
              pastThreshold: r.pastThreshold,
              firstRecordTimestamp: r.firstRecordTimestamp,
              newRecordCount: r.newRecords.length,
              newRecords: r.newRecords,
              openAskId: r.openAskId,
              // mt#3610: the JSON path is what an AGENT reads, and an agent is
              // who misread the records in the originating incident — so the
              // verdict has to be here, not only in the human-readable text.
              classifiability: r.classifiability,
            })),
            reviewDue: reviewDue.map((d) => ({
              name: d.name,
              path: d.path,
              reason: d.reason,
              firesSinceLastReview: d.firesSinceLastReview,
              totalFires: d.totalFires,
              distinctPhrases: d.distinctPhrases,
              openAskId: d.openAskId,
            })),
            watermarkAdvanced,
            clearedAskId,
            skippedOpenAskPaths,
            // mt#3899: paths whose intended write was dropped because another
            // pass changed them mid-sweep. Empty on every uncontended run.
            driftedPaths,
            // mt#4164: logs another pass is actively classifying right now.
            // They are EXCLUDED from `reviewDue` above — this pass stands down
            // on them. `driftedPaths` is the sibling AFTER-the-fact signal;
            // this one fires before the work, which is the whole point.
            claimedByOthers,
            // True when the runtime could not name this pass, so no claim was
            // taken and none was honoured. Reported rather than silent: a pass
            // that cannot claim is running with the pre-mt#4164 collision risk.
            claimsUnavailable: actorId === null,
            // mt#3906: the receipt for THIS read — pass it back as
            // `reviewToken` on the ack that follows.
            reviewToken,
            // Records that landed while the reviewer was working. They stay
            // unreviewed by design; naming them is what lets a reviewer see
            // the tail rather than infer it from a later sweep.
            midPassArrivals,
            clampedPaths,
            unreceiptedPaths,
            // mt#4391: logs that became review-due AFTER this pass's token was
            // issued. Not advanced, because nobody classified them — the
            // set-shaped sibling of `midPassArrivals`.
            newlyDuePaths,
            // Also not advanced, for a DIFFERENT reason: due at mint time, but
            // another pass held a claim so this one stood down (PR #3214 R1).
            claimHeldPaths,
            // Presented as due by THIS token, advanced by someone else before
            // the ack landed — the classification here was duplicated (mt#4408).
            ackedByAnotherPass,
          };
        }

        const text = formatResult(results, reviewDue);
        const suffix = watermarkAdvanced
          ? "\nWatermarks advanced for review-due logs."
          : params.ack && skippedOpenAskPaths.length === 0
            ? "\nNo review-due logs to advance."
            : "";
        const clearedSuffix = clearedAskId ? "\nCleared resolved ask from watermark(s)." : "";
        const skippedSuffix =
          skippedOpenAskPaths.length > 0
            ? `\nSkipped ${skippedOpenAskPaths.length} log(s) with a still-open disposition ask ` +
              `(no askId supplied): ${skippedOpenAskPaths.join(", ")}`
            : "";
        // mt#3899: name the dropped writes. A pass that silently loses the race
        // reads identically to one that won it, which is what made the
        // originating incident invisible until the counts were compared by hand.
        const driftedSuffix =
          driftedPaths.length > 0
            ? `\nDropped ${driftedPaths.length} write(s) — another pass changed these logs ` +
              `mid-sweep; their values stand: ${driftedPaths.join(", ")}`
            : "";

        // mt#4164: the BEFORE-the-work sibling of the line above. A pass that
        // sees this has not wasted anything yet, which is the difference the
        // claim mechanism exists to make.
        const claimedSuffix =
          claimedByOthers.length > 0
            ? `\nStood down on ${claimedByOthers.length} log(s) — another pass is classifying ` +
              `them now:\n  ${describeBlockingClaims(
                blockingClaims(
                  await loadClaims(workspacePath),
                  claimedByOthers,
                  actorId ?? "",
                  Date.now()
                )
              ).join("\n  ")}`
            : "";

        // mt#3906: the tail the ack declined to advance over. A reviewer who
        // cannot see this number has to infer it from a later sweep, which is
        // how it went unnoticed for as long as it did.
        const midPassSuffix =
          midPassArrivals.length > 0
            ? `\nLeft ${midPassArrivals.reduce((n, a) => n + a.count, 0)} record(s) unreviewed — ` +
              `they arrived after the read this ack is bound to: ${midPassArrivals
                .map((a) => `${a.path} (+${a.count})`)
                .join(", ")}`
            : "";
        const clampedSuffix =
          clampedPaths.length > 0
            ? `\nRaised ${clampedPaths.length} count(s) to the existing watermark — the token ` +
              `predates a later review: ${clampedPaths.join(", ")}`
            : "";
        const unreceiptedSuffix =
          unreceiptedPaths.length > 0
            ? `\nNot advanced (the token does not cover these logs; re-run read-only for a ` +
              `current token): ${unreceiptedPaths.join(", ")}`
            : "";
        // Named rather than dropped (mt#4391): these crossed a threshold DURING
        // the pass, so they are waiting to be reviewed, not reviewed. Saying so
        // here is what keeps the skip from being the same invisible loss the
        // advance was.
        const newlyDueSuffix =
          newlyDuePaths.length > 0
            ? `\nNot advanced (became review-due after this token was issued, so nobody ` +
              `classified them — they are in the next sweep): ${newlyDuePaths.join(", ")}`
            : "";
        const claimHeldSuffix =
          claimHeldPaths.length > 0
            ? `\nNot advanced (another pass held these when this token was issued, so you ` +
              `stood down on them rather than classifying them): ${claimHeldPaths.join(", ")}`
            : "";
        const ackedByAnotherPassSuffix =
          ackedByAnotherPass.length > 0
            ? `\nLOST: another pass advanced these while you were classifying them, so this ` +
              `ack wrote nothing for them and your review of them was duplicated. Their ` +
              `watermarks reflect the other pass's review, not yours — do NOT re-ack to force ` +
              `it through; reconcile with whatever that pass filed instead: ` +
              `${ackedByAnotherPass.join(", ")}`
            : "";
        // Say the degradation in WORDS, not only as a JSON boolean (mt#4408).
        // `claimsUnavailable: true` was reported all along and read past on both
        // sides of the R4 collision — a field a reader must know to look for is
        // not a warning. Now that the MCP path resolves identity (SC1), this
        // should be rare, which is exactly why it should be loud when it fires.
        const claimsUnavailableSuffix =
          actorId === null && reviewDueAll.length > 0
            ? `\nWARNING: this pass has no resolvable identity, so it claimed nothing and a ` +
              `concurrent pass will not be warned off these logs. Any claim shown above was ` +
              `read, not taken. Check for a pass already in flight before classifying.`
            : "";
        const tokenSuffix = `\nreviewToken: ${reviewToken}`;

        return {
          success: true,
          json: false,
          message:
            text +
            suffix +
            clearedSuffix +
            skippedSuffix +
            driftedSuffix +
            claimedSuffix +
            midPassSuffix +
            clampedSuffix +
            unreceiptedSuffix +
            newlyDueSuffix +
            claimHeldSuffix +
            ackedByAnotherPassSuffix +
            claimsUnavailableSuffix +
            tokenSuffix,
          watermarkAdvanced,
          clearedAskId,
          skippedOpenAskPaths,
          driftedPaths,
          reviewToken,
          midPassArrivals,
          clampedPaths,
          unreceiptedPaths,
          newlyDuePaths,
          claimHeldPaths,
          ackedByAnotherPass,
        };
      } catch (error) {
        return {
          success: false,
          json: params.json ?? false,
          error: `Calibration review failed: ${getErrorMessage(error)}`,
        };
      }
    },
  });
}
