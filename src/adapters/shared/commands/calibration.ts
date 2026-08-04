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
import {
  CALIBRATION_LOG_REGISTRY,
  runSweep,
  computeReviewDueLogs,
  advanceWatermarks,
  clearResolvedAskIds,
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

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatResult(results: CalibrationLogResult[], reviewDue: ReviewDueLog[]): string {
  const lines: string[] = ["=== Calibration Review Sweep ===", ""];
  const reasonByPath = new Map(reviewDue.map((d) => [d.path, d.reason]));

  for (const r of results) {
    lines.push(`Log: ${r.entry.name} (${r.entry.path})`);
    lines.push(`  Exists:                 ${r.exists}`);
    lines.push(`  Total fires (all-time): ${r.totalFires}`);
    lines.push(`  Watermark count:        ${r.watermarkCount}`);
    lines.push(`  Fires since review:     ${r.firesSinceLastReview}`);
    // mt#3197: the positional count above includes detections that were
    // suppressed before reaching the operator. Show the split so a reviewer
    // never mistakes log volume for attention cost.
    if (r.suppressedSinceLastReview > 0) {
      lines.push(`    ...suppressed:        ${r.suppressedSinceLastReview} (never injected)`);
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

  const pastThresholdLogs = results.filter((r) => r.pastThreshold);
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
      pastThresholdLogs.length > 0
        ? `Re-run with --ack to advance watermarks for the ${pastThresholdLogs.length} past-threshold log(s) after review.`
        : "Note: --ack advances past-threshold logs only; time-stale / never-reviewed ack is mt#2878."
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
          "Advance the watermark for all past-threshold logs, marking them as reviewed. " +
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
      askId: {
        schema: z.string(),
        description:
          "ID of the disposition Ask just filed for the past-threshold logs in this pass " +
          "(mt#2659). Only meaningful together with ack:true — recorded as `openAskId` on " +
          "every watermark advanced by this call so the cadence-detector hook suppresses its " +
          "per-turn warning for these logs until the ask is resolved. A past-threshold log " +
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
          "one /calibration-review pass files exactly ONE ask covering all past-threshold logs " +
          "in that pass, so exactly one id is ever cleared at a time in practice — this also " +
          "sidesteps CLI array-flag delimiter ambiguity (comma-split vs repeatable flag) that " +
          "the shared command-registry's CLI bridge does not currently resolve for array-typed " +
          "Zod schemas.",
        required: false,
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

        // Clear a resolved disposition-ask reference first (mt#2659) — this
        // is independent of --ack and does not touch lastReviewedCount/At.
        let clearedAskId = false;
        if (params.clearAskId) {
          const clearedWatermarks = clearResolvedAskIds(watermarks, new Set([params.clearAskId]));
          if (clearedWatermarks !== watermarks) {
            watermarks = clearedWatermarks;
            await saveWatermarks(workspacePath, watermarks);
            clearedAskId = true;
          }
        }

        const results = await runSweep(CALIBRATION_LOG_REGISTRY, readContent, watermarks);

        // Review-due determination (mt#2896) — the SAME domain function the
        // cadence hook uses, so the command surfaces time-stale / never-reviewed
        // logs, not only pastThreshold. `--ack` below advances exactly this set
        // (mt#2878), so what an operator can discharge is BY CONSTRUCTION what
        // the cadence hook warns about.
        const reviewDue = computeReviewDueLogs(results, watermarks, Date.now());

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
        let watermarkAdvanced = false;
        let skippedOpenAskPaths: string[] = [];
        if (params.ack) {
          const reviewDuePaths = new Set(reviewDue.map((d) => d.path));
          const reviewDueResults = results.filter((r) => reviewDuePaths.has(r.entry.path));
          const selection = selectAckablePaths(reviewDueResults, params.askId);
          skippedOpenAskPaths = selection.skippedOpenAskPaths;
          if (selection.ackablePaths.size > 0) {
            const updated = advanceWatermarks(
              watermarks,
              results,
              selection.ackablePaths,
              new Date().toISOString(),
              params.askId
            );
            await saveWatermarks(workspacePath, updated);
            watermarkAdvanced = true;
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
          };
        }

        const text = formatResult(results, reviewDue);
        const suffix = watermarkAdvanced
          ? "\nWatermarks advanced for past-threshold logs."
          : params.ack && skippedOpenAskPaths.length === 0
            ? "\nNo past-threshold logs to advance."
            : "";
        const clearedSuffix = clearedAskId ? "\nCleared resolved ask from watermark(s)." : "";
        const skippedSuffix =
          skippedOpenAskPaths.length > 0
            ? `\nSkipped ${skippedOpenAskPaths.length} log(s) with a still-open disposition ask ` +
              `(no askId supplied): ${skippedOpenAskPaths.join(", ")}`
            : "";

        return {
          success: true,
          json: false,
          message: text + suffix + clearedSuffix + skippedSuffix,
          watermarkAdvanced,
          clearedAskId,
          skippedOpenAskPaths,
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
