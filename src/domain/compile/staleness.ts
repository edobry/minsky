/**
 * Staleness Detection
 *
 * Shared helper that compares expected compile output against on-disk files.
 * Used by MinskyCompileService in --check mode. Reusable across all targets.
 */

import type { MinskyCompileFsDeps, MinskyCompileTarget, MinskyTargetOptions } from "./types";
import { basename, join } from "path";

export interface StalenessResult {
  stale: boolean;
  staleFile?: string;
}

/**
 * Check whether a target's output is stale relative to the on-disk files.
 *
 * Algorithm:
 * 1. Ask the target for its expected output file list.
 * 2. For each expected file: if missing or content differs, return stale.
 * 3. Detect orphan files: files present in the output dir but not expected.
 *
 * @param target   The compile target to check.
 * @param options  Target options (output path override etc.).
 * @param workspacePath  Absolute path to the project root.
 * @param expectedContents  Map from file path to expected content string.
 * @param fsDeps   Injectable fs (uses real fs if omitted).
 */
export async function checkStaleness(
  target: MinskyCompileTarget,
  options: MinskyTargetOptions,
  workspacePath: string,
  expectedContents: Map<string, string>,
  fsDeps: MinskyCompileFsDeps
): Promise<StalenessResult> {
  const expectedFiles = await target.listOutputFiles(options, workspacePath, fsDeps);

  // Check every expected file for staleness
  for (const filePath of expectedFiles) {
    let existingContent: string;
    try {
      existingContent = await fsDeps.readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist — stale
      return { stale: true, staleFile: filePath };
    }

    const expectedContent = expectedContents.get(filePath);
    if (expectedContent === undefined || existingContent !== expectedContent) {
      return { stale: true, staleFile: filePath };
    }
  }

  // Detect orphan files: check output directory for files that shouldn't be there
  const outputDir = options.outputPath ?? target.defaultOutputPath(workspacePath);
  const expectedBasenames = new Set(expectedFiles.map((f) => basename(f)));

  try {
    const entries = await fsDeps.readdir(outputDir);
    for (const entry of entries) {
      if (!expectedBasenames.has(entry)) {
        return { stale: true, staleFile: join(outputDir, entry) };
      }
    }
  } catch {
    // Output directory does not exist — already covered by expectedFiles check above
  }

  return { stale: false };
}
