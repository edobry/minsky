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
    },
    async execute(params, ctx) {
      try {
        const workspacePath = resolveWorkspacePath(ctx);
        const { join } = await import("node:path");

        // Build the reader function (resolves repo-relative paths)
        const readContent = async (relPath: string): Promise<string | null> => {
          return readFileOrNull(join(workspacePath, relPath));
        };

        const watermarks = await loadWatermarks(workspacePath);
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
              new Date().toISOString()
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
            })),
            watermarkAdvanced,
          };
        }

        const text = formatResult(results);
        const suffix = watermarkAdvanced
          ? "\nWatermarks advanced for past-threshold logs."
          : params.ack
            ? "\nNo past-threshold logs to advance."
            : "";

        return {
          success: true,
          json: false,
          message: text + suffix,
          watermarkAdvanced,
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
