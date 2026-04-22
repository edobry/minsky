/**
 * Minsky Compile Service
 *
 * Orchestrates multi-target compilation of TypeScript definition modules
 * into harness-specific output formats (skills, agents, rules, etc.).
 */

import realFs from "fs/promises";
import { injectable } from "tsyringe";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "./types";
import { claudeSkillsTarget } from "./targets/claude-skills";

export interface MinskyCompileOptions extends MinskyTargetOptions {
  workspacePath: string;
  check?: boolean;
}

export interface MinskyCompileServiceResult extends MinskyCompileResult {
  /** Populated in --check mode: whether output files are up-to-date */
  stale?: boolean;
  staleFile?: string;
  check?: boolean;
}

@injectable()
export class MinskyCompileService {
  private targets = new Map<string, MinskyCompileTarget>();

  registerTarget(target: MinskyCompileTarget): void {
    this.targets.set(target.id, target);
  }

  getAvailableTargets(): string[] {
    return Array.from(this.targets.keys());
  }

  getTarget(targetId: string): MinskyCompileTarget | undefined {
    return this.targets.get(targetId);
  }

  async compile(
    targetId: string,
    options: MinskyCompileOptions,
    fsDeps?: MinskyCompileFsDeps
  ): Promise<MinskyCompileServiceResult> {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(
        `Unknown compile target: "${targetId}". Available targets: ${this.getAvailableTargets().join(", ")}`
      );
    }

    const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
    const { workspacePath, check, ...targetOptions } = options;

    if (check) {
      return this.runCheckMode(target, targetOptions, workspacePath, fs);
    }

    return target.compile(targetOptions, workspacePath, fs);
  }

  private async runCheckMode(
    target: MinskyCompileTarget,
    targetOptions: MinskyTargetOptions,
    workspacePath: string,
    fs: MinskyCompileFsDeps
  ): Promise<MinskyCompileServiceResult> {
    // Dry-run to get expected file paths and content
    const dryResult = await target.compile({ ...targetOptions, dryRun: true }, workspacePath, fs);

    const expectedFiles = await target.listOutputFiles(targetOptions, workspacePath, fs);

    // Check every expected file for staleness
    let staleFile: string | undefined;

    for (const filePath of expectedFiles) {
      let existingContent: string;
      try {
        existingContent = await fs.readFile(filePath, "utf-8");
      } catch {
        staleFile = filePath;
        break;
      }

      const expectedContent = resolveExpectedContent(dryResult, filePath);
      if (expectedContent === undefined || existingContent !== expectedContent) {
        staleFile = filePath;
        break;
      }
    }

    // Note: orphan detection (files in output dir not expected by the target) is
    // intentionally skipped here. The claude-skills output dir (.claude/skills/) is
    // shared between compiled and hand-authored skills, so orphan detection would
    // produce false positives. Targets that exclusively own their output directory
    // can implement orphan detection in their own listOutputFiles + compile logic.

    const isStale = staleFile !== undefined;
    return {
      ...dryResult,
      check: true,
      stale: isStale,
      staleFile,
    };
  }
}

/**
 * Resolve the expected content for a given output file path from a dry-run result.
 *
 * - If the result has `contentsByPath`, use it (multi-file targets).
 * - If there is exactly one file written, use `content` directly.
 * - Otherwise return undefined (staleness check will mark as stale).
 */
function resolveExpectedContent(result: MinskyCompileResult, filePath: string): string | undefined {
  if (result.contentsByPath !== undefined) {
    return result.contentsByPath.get(filePath);
  }
  if (result.filesWritten.length === 1) {
    return result.content;
  }
  return undefined;
}

/**
 * Factory that returns a MinskyCompileService with the default targets pre-registered.
 */
export function createMinskyCompileService(): MinskyCompileService {
  const service = new MinskyCompileService();
  service.registerTarget(claudeSkillsTarget);
  return service;
}
