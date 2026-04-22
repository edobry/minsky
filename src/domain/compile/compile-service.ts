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
import { checkStaleness } from "./staleness";
import { claudeSkillsTarget } from "./targets/claude-skills";
import { claudeAgentsTarget } from "./targets/claude-agents";
import { cursorRulesTsTarget } from "./targets/cursor-rules-ts";

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

    // Delegate staleness check to the shared helper. Orphan detection is skipped
    // when the target declares its output directory is shared with hand-authored
    // content (e.g. claude-skills' .claude/skills/).
    const expectedContents = buildExpectedContents(dryResult);
    const { stale, staleFile } = await checkStaleness(
      target,
      targetOptions,
      workspacePath,
      expectedContents,
      fs,
      { skipOrphanDetection: target.sharedOutputDirectory === true }
    );

    return {
      ...dryResult,
      check: true,
      stale,
      staleFile,
    };
  }
}

/**
 * Build the expected-content map that checkStaleness consumes from a dry-run result.
 *
 * - Multi-file targets populate `contentsByPath` directly.
 * - Single-file targets set `content` + exactly one `filesWritten` path.
 * - Anything else produces an empty map; checkStaleness will flag files as stale
 *   since it can't find expected content for them.
 */
function buildExpectedContents(result: MinskyCompileResult): Map<string, string> {
  if (result.contentsByPath !== undefined) {
    return new Map(result.contentsByPath);
  }
  if (result.filesWritten.length === 1 && result.content !== undefined) {
    const first = result.filesWritten[0];
    if (first !== undefined) {
      return new Map([[first, result.content]]);
    }
  }
  return new Map();
}

/**
 * Factory that returns a MinskyCompileService with the default targets pre-registered.
 */
export function createMinskyCompileService(): MinskyCompileService {
  const service = new MinskyCompileService();
  service.registerTarget(claudeSkillsTarget);
  service.registerTarget(claudeAgentsTarget);
  service.registerTarget(cursorRulesTsTarget);
  return service;
}
