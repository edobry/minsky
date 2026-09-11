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
import {
  guardForeignWrites,
  foreignFileSkipReason,
  classifyOutputOwnership,
} from "./foreign-file-guard";
import { claudeSkillsTarget } from "./targets/claude-skills";
import { claudeAgentsTarget } from "./targets/claude-agents";
import { cursorRulesTsTarget } from "./targets/cursor-rules-ts";
import { claudeHooksTarget } from "./targets/claude-hooks";
import { claudeMdTarget } from "./targets/claude-md";
import { agentsMdTarget } from "./targets/agents-md";
import { claudeRulesTarget } from "./targets/claude-rules";
import { unknownCompileTargetMessage } from "../rules/compile/target-error-hint";

export interface MinskyCompileOptions extends MinskyTargetOptions {
  workspacePath: string;
  check?: boolean;
  /**
   * Replace per-file outputs that exist without a generation banner (mt#5065).
   * Without it such a file is refused and reported under
   * `skippedForeignOutputs`; with it, written and reported under
   * `foreignOverwritten`. Never reaches a target — the guard in `compile()`
   * consumes it.
   */
  overwrite?: boolean;
}

export interface MinskyCompileServiceResult extends MinskyCompileResult {
  /** Populated in --check mode: whether output files are up-to-date */
  stale?: boolean;
  staleFile?: string;
  check?: boolean;
  /**
   * Populated when a bare (no explicit `--target`) invocation of
   * `runMinskyCompile` probed and compiled MULTIPLE applicable targets
   * (mt#2803). Each entry mirrors this result shape, scoped to one target.
   * When present, the top-level fields above carry a cross-target aggregate
   * (`filesWritten` etc. concatenated, `target` a joined id list) — consumers
   * that want per-target detail should iterate `targets` instead. Absent for
   * explicit `--target` invocations and for bare invocations that probe to
   * exactly one applicable target.
   */
  targets?: MinskyCompileTargetOutcome[];
}

/**
 * Per-target outcome inside a multi-target `MinskyCompileServiceResult.targets`
 * array (mt#2803). Mirrors `MinskyCompileServiceResult` minus `targets`
 * itself, which does not nest.
 */
export type MinskyCompileTargetOutcome = Omit<MinskyCompileServiceResult, "targets">;

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
      throw new Error(unknownCompileTargetMessage(targetId, this.getAvailableTargets()));
    }

    const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
    const { workspacePath, check, overwrite, ...targetOptions } = options;

    if (check) {
      return this.runCheckMode(target, targetOptions, workspacePath, fs);
    }

    if (targetOptions.dryRun) {
      return target.compile(targetOptions, workspacePath, fs);
    }

    // mt#5065: every per-file write goes through the ownership guard. The
    // target sees an ordinary fs; a path that exists without a generation
    // banner is refused here (or replaced on `--overwrite`) and the target's
    // own `filesWritten` — which it pushes AFTER calling writeFile, without
    // knowing the write was declined — is corrected below so a refused path
    // is never reported as written. The monolithic targets are unaffected:
    // their foreign outputs are gated out before this runs, and a banner-
    // carrying `CLAUDE.md` passes the same predicate they already apply.
    const guarded = guardForeignWrites(fs, { overwrite });
    const result = await target.compile(targetOptions, workspacePath, guarded.fs);
    if (guarded.skipped.length === 0 && guarded.overwritten.length === 0) {
      return result;
    }
    const refused = new Set(guarded.skipped.map((s) => s.path));
    const skippedForeignOutputs = [...(result.skippedForeignOutputs ?? []), ...guarded.skipped];
    return {
      ...result,
      filesWritten: result.filesWritten.filter((p) => !refused.has(p)),
      ...(skippedForeignOutputs.length > 0 ? { skippedForeignOutputs } : {}),
      ...(guarded.overwritten.length > 0 ? { foreignOverwritten: guarded.overwritten } : {}),
    };
  }

  private async runCheckMode(
    target: MinskyCompileTarget,
    targetOptions: MinskyTargetOptions,
    workspacePath: string,
    fs: MinskyCompileFsDeps
  ): Promise<MinskyCompileServiceResult> {
    // Dry-run to get expected file paths and content
    const dryResult = await target.compile({ ...targetOptions, dryRun: true }, workspacePath, fs);

    // mt#5065: a per-file output that exists without a banner is the user's,
    // and `compile` will not write it — so `--check` must not call it stale
    // either, or a project carrying one collision fails its pre-commit check
    // forever. Such paths are dropped from the comparison and reported the
    // same way the write path reports them.
    // The classification needs the would-be content, so it runs over the
    // expected-content map rather than the bare path list: a pre-banner copy of
    // our own output stays IN the comparison (and reads as stale, correctly —
    // regenerating it adds the banner), while a genuinely foreign file leaves it.
    const expectedContents = buildExpectedContents(dryResult);
    const foreignSkips: { path: string; reason: string }[] = [];
    for (const [path, content] of expectedContents) {
      const ownership = await classifyOutputOwnership(path, content, fs);
      if (ownership === "foreign" || ownership === "unreadable") {
        foreignSkips.push({ path, reason: foreignFileSkipReason(path, ownership) });
      }
    }
    const foreignPaths = new Set(foreignSkips.map((s) => s.path));

    // Delegate staleness check to the shared helper. Orphan detection is skipped
    // when the target declares its output directory is shared with hand-authored
    // content (e.g. claude-skills' .claude/skills/).
    const { stale, staleFile } = await checkStaleness(
      target,
      targetOptions,
      workspacePath,
      expectedContents,
      fs,
      {
        skipOrphanDetection: target.sharedOutputDirectory === true,
        ignorePaths: foreignPaths.size > 0 ? foreignPaths : undefined,
      }
    );

    return {
      ...dryResult,
      filesWritten: dryResult.filesWritten.filter((p) => !foreignPaths.has(p)),
      ...(foreignSkips.length > 0
        ? {
            skippedForeignOutputs: [...(dryResult.skippedForeignOutputs ?? []), ...foreignSkips],
          }
        : {}),
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
 *
 * `claude.md` / `agents.md` / `claude-rules` (mt#2992, Phase 1 of ADR-016
 * convergence) are registered here — reachable via explicit
 * `compile --target <id>` — but land DORMANT: they are deliberately NOT
 * added to `minskyCompileTargetsFromPresence` (`./compile.ts`) or
 * `compileCheckTargets` (`src/hooks/pre-commit.ts`), so a bare `minsky
 * compile` and pre-commit's staleness check are unaffected by this task.
 * Legacy (`rules compile`) remains the authoritative writer for all three
 * until the cutover task (mt#3058) flips them atomically.
 */
export function createMinskyCompileService(): MinskyCompileService {
  const service = new MinskyCompileService();
  service.registerTarget(claudeSkillsTarget);
  service.registerTarget(claudeAgentsTarget);
  service.registerTarget(cursorRulesTsTarget);
  service.registerTarget(claudeHooksTarget);
  service.registerTarget(claudeMdTarget);
  service.registerTarget(agentsMdTarget);
  service.registerTarget(claudeRulesTarget);
  return service;
}
