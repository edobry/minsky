/**
 * Compile Operation
 *
 * Top-level operation that the CLI adapter calls. Encapsulates target lookup,
 * stale-check routing, and dry-run handling.
 */

import realFs from "fs/promises";
import path from "path";
import { resolveWorkspacePath } from "../workspace";
import { createMinskyCompileService, type MinskyCompileService } from "./compile-service";
import type { MinskyCompileServiceResult, MinskyCompileTargetOutcome } from "./compile-service";
import type { MinskyCompileFsDeps } from "./types";

export interface RunMinskyCompileOptions {
  /** Target to compile. When omitted, all applicable targets are probed and compiled (mt#2803). */
  target?: string;
  /** Override output path/directory. */
  output?: string;
  /** Print content without writing files. */
  dryRun?: boolean;
  /** Exit non-zero if output is stale. Does not write files. */
  check?: boolean;
  /** Workspace path (resolved automatically if omitted). */
  workspacePath?: string;
  /** Injectable fs for testing — target-probing and pass-through to the compile service. Uses real fs/promises when omitted. */
  fsDeps?: MinskyCompileFsDeps;
}

/**
 * Maps which `.minsky/` source dirs are present to the new-pipeline compile
 * targets a bare `minsky compile` invocation should regenerate (mt#2803).
 * Mirrors `compileCheckTargets`'s mapping in src/hooks/pre-commit.ts —
 * intentionally duplicated rather than imported: that file already imports
 * from `@minsky/domain`, so an import in the other direction would be
 * circular. Keep the two mappings in sync if a new target is added.
 * Exported for unit testing.
 */
export function minskyCompileTargetsFromPresence(present: {
  skills: boolean;
  rules: boolean;
  agents: boolean;
  hooks: boolean;
}): string[] {
  const targets: string[] = [];
  if (present.skills) targets.push("claude-skills");
  if (present.rules) targets.push("cursor-rules-ts");
  if (present.agents) targets.push("claude-agents");
  if (present.hooks) targets.push("claude-hooks");
  return targets;
}

/**
 * Probe which new-pipeline compile targets have an existing `.minsky/`
 * source dir, driving the bare (no `--target`) invocation's default target
 * set (mt#2803). Returns an empty array when no source dir exists (fresh
 * repo) — callers fall back to the single "claude-skills" default in that
 * case, matching pre-mt#2803 behavior. Exported for unit testing.
 */
export async function probeMinskyCompileTargets(
  workspacePath: string,
  fsDeps: MinskyCompileFsDeps
): Promise<string[]> {
  const dirExists = async (dirPath: string): Promise<boolean> => {
    try {
      await fsDeps.access(dirPath);
      return true;
    } catch {
      return false;
    }
  };

  return minskyCompileTargetsFromPresence({
    skills: await dirExists(path.join(workspacePath, ".minsky", "skills")),
    rules: await dirExists(path.join(workspacePath, ".minsky", "rules")),
    agents: await dirExists(path.join(workspacePath, ".minsky", "agents")),
    hooks: await dirExists(path.join(workspacePath, ".minsky", "hooks")),
  });
}

/**
 * Compile exactly one target. Extracted so the bare-invocation multi-target
 * loop (mt#2803) can invoke it once per probed target.
 */
async function compileSingleMinskyTarget(
  compileService: MinskyCompileService,
  targetId: string,
  options: RunMinskyCompileOptions,
  workspacePath: string
): Promise<MinskyCompileServiceResult> {
  if (!compileService.getTarget(targetId)) {
    throw new Error(
      `Unknown compile target: "${targetId}". Available targets: ${compileService.getAvailableTargets().join(", ")}`
    );
  }

  return compileService.compile(
    targetId,
    {
      workspacePath,
      outputPath: options.output,
      dryRun: options.dryRun,
      check: options.check,
    },
    options.fsDeps
  );
}

/**
 * Compile the new-pipeline TypeScript-definition targets.
 *
 * With an explicit `options.target`, compiles exactly that one target
 * (unchanged behavior). On a bare invocation (no `target`), probes which
 * targets have an existing `.minsky/` source dir (mt#2803,
 * {@link probeMinskyCompileTargets}) and compiles every one of them so a
 * partial regen is never silently reported as success. When no source dir
 * exists (fresh repo), falls back to the single "claude-skills" default.
 *
 * When the probe resolves to more than one target, the top-level result's
 * `filesWritten` / `definitionsIncluded` / `definitionsSkipped` are the
 * concatenation across targets, `stale` is aggregated via OR (check mode
 * only), `target` is a comma-joined id list, and the new `targets` field
 * carries the full per-target breakdown. Single-target invocations (explicit
 * `--target`, or a bare invocation that probes to exactly one target) return
 * the classic single-target shape unchanged.
 */
export async function runMinskyCompile(
  options: RunMinskyCompileOptions
): Promise<MinskyCompileServiceResult> {
  const workspacePath = options.workspacePath ?? (await resolveWorkspacePath({}));
  const compileService = createMinskyCompileService();
  const fsDeps: MinskyCompileFsDeps = options.fsDeps ?? (realFs as MinskyCompileFsDeps);

  if (options.target) {
    return compileSingleMinskyTarget(compileService, options.target, options, workspacePath);
  }

  // mt#2803: bare invocation — regenerate every applicable target instead of
  // silently compiling only the single new-pipeline default.
  const probedTargets = await probeMinskyCompileTargets(workspacePath, fsDeps);
  const targetIds = probedTargets.length > 0 ? probedTargets : ["claude-skills"];

  const [onlyTargetId] = targetIds;
  if (targetIds.length === 1 && onlyTargetId) {
    return compileSingleMinskyTarget(compileService, onlyTargetId, options, workspacePath);
  }

  const targets: MinskyCompileTargetOutcome[] = [];
  const filesWritten: string[] = [];
  const definitionsIncluded: string[] = [];
  const definitionsSkipped: string[] = [];
  let overallStale = false;

  for (const targetId of targetIds) {
    const single = await compileSingleMinskyTarget(
      compileService,
      targetId,
      options,
      workspacePath
    );
    targets.push({ ...single, target: targetId });
    if (single.stale) overallStale = true;
    filesWritten.push(...single.filesWritten);
    definitionsIncluded.push(...single.definitionsIncluded);
    definitionsSkipped.push(...single.definitionsSkipped);
  }

  return {
    target: targetIds.join(", "),
    filesWritten,
    definitionsIncluded,
    definitionsSkipped,
    check: options.check,
    stale: options.check ? overallStale : undefined,
    targets,
  };
}
