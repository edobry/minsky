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
  advanceWatermarks,
  clearResolvedAskIds,
  type CalibrationLogResult,
  type WatermarkStore,
} from "../../../domain/calibration/calibration-sweep";

// ---------------------------------------------------------------------------
// Watermark store path (repo-relative)
// ---------------------------------------------------------------------------

const WATERMARK_STORE_PATH = ".minsky/calibration-review-watermarks.json";

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

function formatResult(results: CalibrationLogResult[]): string {
  const lines: string[] = ["=== Calibration Review Sweep ===", ""];

  for (const r of results) {
    lines.push(`Log: ${r.entry.name} (${r.entry.path})`);
    lines.push(`  Exists:                 ${r.exists}`);
    lines.push(`  Total fires (all-time): ${r.totalFires}`);
    lines.push(`  Watermark count:        ${r.watermarkCount}`);
    lines.push(`  Fires since review:     ${r.firesSinceLastReview}`);
    lines.push(`  Distinct phrases:       ${r.distinctPhrases}`);
    lines.push(`  At count threshold:     ${r.atCountThreshold}`);
    lines.push(`  Past threshold:         ${r.pastThreshold}`);
    if (r.openAskId) {
      lines.push(`  Open ask (mt#2659):     ${r.openAskId} — disposition pending`);
    }
    if (r.lowDiversity) {
      lines.push(`  ⚠  Low diversity (count bar hit but < 3 distinct phrases) — keep collecting`);
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
        } else {
          lines.push(
            `    [${rec.timestamp}] families: ${rec.matches
              .slice(0, 3)
              .map((m) => `${m.family}:${m.phrase.slice(0, 40)}`)
              .join(", ")}`
          );
        }
      }
      if (r.newRecords.length > 5) {
        lines.push(`    ... and ${r.newRecords.length - 5} more`);
      }
    }
    lines.push("");
  }

  const pastThresholdLogs = results.filter((r) => r.pastThreshold);
  if (pastThresholdLogs.length === 0) {
    lines.push("No logs have reached the review threshold.");
  } else {
    lines.push(
      `${pastThresholdLogs.length} log(s) past threshold. ` +
        `Re-run with --ack to advance watermarks after review.`
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
          "per-turn warning for these logs until the ask is resolved.",
        required: false,
      },
      clearAskIds: {
        schema: z.array(z.string()),
        description:
          "Ask IDs to clear from any watermark's `openAskId` field (mt#2659). Pass the id(s) " +
          "once `asks_list` confirms a previously-filed disposition ask has reached a terminal " +
          "state (responded/closed/cancelled/expired) — clearing resumes the cadence " +
          "detector's normal per-turn warning for the affected log(s). Independent of ack; " +
          "applied before the sweep result is computed.",
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

        // Clear any resolved disposition-ask references first (mt#2659) — this
        // is independent of --ack and does not touch lastReviewedCount/At.
        let clearedAskIds = false;
        if (params.clearAskIds && params.clearAskIds.length > 0) {
          const clearedWatermarks = clearResolvedAskIds(watermarks, new Set(params.clearAskIds));
          if (clearedWatermarks !== watermarks) {
            watermarks = clearedWatermarks;
            await saveWatermarks(workspacePath, watermarks);
            clearedAskIds = true;
          }
        }

        const results = await runSweep(CALIBRATION_LOG_REGISTRY, readContent, watermarks);

        // Advance watermarks for past-threshold logs when --ack is set
        let watermarkAdvanced = false;
        if (params.ack) {
          const pastThresholdPaths = new Set(
            results.filter((r) => r.pastThreshold).map((r) => r.entry.path)
          );
          if (pastThresholdPaths.size > 0) {
            const updated = advanceWatermarks(
              watermarks,
              results,
              pastThresholdPaths,
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
              distinctPhrases: r.distinctPhrases,
              atCountThreshold: r.atCountThreshold,
              lowDiversity: r.lowDiversity,
              pastThreshold: r.pastThreshold,
              newRecordCount: r.newRecords.length,
              newRecords: r.newRecords,
              openAskId: r.openAskId,
            })),
            watermarkAdvanced,
            clearedAskIds,
          };
        }

        const text = formatResult(results);
        const suffix = watermarkAdvanced
          ? "\nWatermarks advanced for past-threshold logs."
          : params.ack
            ? "\nNo past-threshold logs to advance."
            : "";
        const clearedSuffix = clearedAskIds ? "\nCleared resolved ask(s) from watermark(s)." : "";

        return {
          success: true,
          json: false,
          message: text + suffix + clearedSuffix,
          watermarkAdvanced,
          clearedAskIds,
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
