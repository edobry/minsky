/**
 * Compile Operation
 *
 * Top-level operation that the CLI adapter calls. Encapsulates target lookup,
 * stale-check routing, and dry-run handling.
 */

import realFs from "fs/promises";
import path from "path";
import { parse as parseYaml } from "yaml";
import { resolveWorkspacePath } from "../workspace";
import { createMinskyCompileService, type MinskyCompileService } from "./compile-service";
import type { MinskyCompileServiceResult, MinskyCompileTargetOutcome } from "./compile-service";
import type { MinskyCompileFsDeps } from "./types";
import type { SizeBudget } from "./size-budget";
import type { MemoryLoadingMode } from "../configuration/schemas/memory";
import { unknownCompileTargetMessage } from "../rules/compile/target-error-hint";
import {
  isForeignMonolith,
  monolithicSkipIfNotOurs,
  monolithicOutputName,
} from "./monolithic-ownership";

/**
 * A target a bare invocation SKIPPED, with why.
 *
 * `kind` exists so callers can act on the two gates differently without
 * string-matching the prose (mt#4986). They have opposite remedies: a
 * `"harness"` skip is opted into with `--target`, while doing that on a
 * `"foreign"` skip would overwrite the user's file — the exact thing the gate
 * is protecting.
 */
export interface MinskyCompileGatedTarget {
  target: string;
  kind: "harness" | "foreign";
  reason: string;
}

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
  /**
   * Per-call size-budget override (mt#2992, threaded from the CLI's
   * `warnChars`/`failChars` params). Only `claude.md`/`agents.md` read this
   * — every other target ignores it.
   */
  sizeBudget?: Partial<SizeBudget>;
  /**
   * Memory-loading mode (mt#2992, threaded from config at the CLI layer).
   * Only `claude.md` reads this — every other target ignores it.
   */
  memoryLoadingMode?: MemoryLoadingMode;
}

/**
 * Maps which `.minsky/` source dirs are present to the new-pipeline compile
 * targets a bare `minsky compile` invocation should regenerate (mt#2803).
 * Mirrors `compileCheckTargets`'s mapping in src/hooks/pre-commit.ts —
 * intentionally duplicated rather than imported: that file already imports
 * from `@minsky/domain`, so an import in the other direction would be
 * circular. Keep the two mappings in sync if a new target is added.
 * Exported for unit testing.
 *
 * mt#3058 cutover: `claude.md`, `agents.md`, and `claude-rules` moved here from
 * the legacy `rules compile` pipeline. All three are sourced from
 * `.minsky/rules/`, so they gate on `present.rules` alongside `cursor-rules-ts`.
 * The new pipeline is now the sole bare-invocation writer of CLAUDE.md /
 * AGENTS.md / .claude/rules — the legacy `probeLegacyCompileTargets` no longer
 * returns them (packages/domain/src/rules/operations/crud-operations.ts).
 */
export function minskyCompileTargetsFromPresence(present: {
  skills: boolean;
  rules: boolean;
  agents: boolean;
  hooks: boolean;
  /**
   * The harness recorded for this project (`workspace.harness` in
   * `.minsky/config.local.yaml`, written by `performSetup`). Optional: when
   * absent — an unsignalled project, or any caller that does not probe it —
   * behaviour is exactly as before, so this is additive for existing callers.
   */
  harness?: string;
  /**
   * Whether each harness-specific output ALREADY exists on disk. A target whose
   * output is present is always regenerated, even when the harness gate below
   * would otherwise skip it: a project that has `.cursor/rules/` or `AGENTS.md`
   * is demonstrably consuming them, and leaving them to rot stale is worse than
   * writing them. Minsky's own repository has both, so this is also what keeps
   * this change a no-op here.
   */
  existingOutputs?: { cursorRules: boolean; agentsMd: boolean };
  /**
   * Whether each monolithic output on disk is the user's own file (mt#4986
   * SC3). See {@link minskyCompileTargetsWithGateReport} for the full rationale.
   */
  foreignOutputs?: { claudeMd: boolean; agentsMd: boolean };
}): string[] {
  // mt#4866 SC3. `cursor-rules-ts` and `agents.md` were selected on the presence
  // of `.minsky/rules/` alone, regardless of harness — so a bare `minsky compile`
  // after a Claude-Code-only `init` wrote 6 `.cursor/rules/*.mdc` files and a
  // 90-byte `AGENTS.md` that nothing in that project reads. Measured live
  // 2026-09-04: with `workspace.harness: claude-code` recorded and only
  // `.minsky/rules/` present, the probe returned all four rules-sourced targets.
  //
  // The RFC states the intended behaviour directly (§Phase 0): "a bare `minsky
  // compile` after a Claude-Code-only `init` stops also writing `.cursor/rules/`
  // and `AGENTS.md`". Both halves, hence `agents.md` is gated here and not left
  // harness-agnostic.
  //
  // `claude.md` and `claude-rules` are NOT gated — they are the two channels
  // Claude Code actually implements (mt#3107), so under this harness they are
  // exactly what should be written.
  //
  // Two escapes, both required by SC3 and both already exercised: an explicit
  // `--target` never reaches this function (`runMinskyCompile` returns early), and
  // an output that already exists stays maintained via `existingOutputs`.
  const { targets } = minskyCompileTargetsWithGateReport(present);
  return targets;
}

/**
 * Which targets a bare invocation compiles, AND which the harness gate SKIPPED.
 *
 * The gate is otherwise invisible: a skipped target simply does not appear, which
 * is indistinguishable from a target that was never applicable. That matters most
 * for the pre-commit staleness check, where a silently-narrowed target set is the
 * difference between "these outputs are current" and "these outputs are not being
 * maintained and nothing will tell you" (PR #3623 R1).
 *
 * `gatedOut` names each skipped target with its reason, so callers can surface it.
 * Returns the same `targets` array {@link minskyCompileTargetsFromPresence} does —
 * that function delegates here, so the two can never disagree.
 */
export function minskyCompileTargetsWithGateReport(present: {
  skills: boolean;
  rules: boolean;
  agents: boolean;
  hooks: boolean;
  harness?: string;
  existingOutputs?: { cursorRules: boolean; agentsMd: boolean };
  /**
   * Whether each monolithic output on disk is the USER's file rather than ours
   * — present, and not carrying the generation banner (mt#4986 SC3).
   *
   * This is the narrowing SC3 asks for, expressed as its own input rather than
   * by redefining `existingOutputs.agentsMd`. Both readings gate `agents.md`
   * out for a foreign `AGENTS.md`; a separate field ALSO covers the two cases
   * `existingOutputs` cannot reach, because that field only ever unlocks a
   * harness escape: a foreign `AGENTS.md` under a NON-claude-code harness
   * (where the escape is never consulted), and `CLAUDE.md`, which has no
   * presence gate at all — it is pushed unconditionally below, so there was
   * nothing to narrow. `CLAUDE.md` is the file this task is named for, and a
   * literal reading of "narrow the presence rule" would not have reached it.
   */
  foreignOutputs?: { claudeMd: boolean; agentsMd: boolean };
}): { targets: string[]; gatedOut: MinskyCompileGatedTarget[] } {
  const claudeCodeOnly = present.harness === "claude-code";
  const cursorRulesExists = present.existingOutputs?.cursorRules ?? false;
  const agentsMdExists = present.existingOutputs?.agentsMd ?? false;
  const claudeMdIsForeign = present.foreignOutputs?.claudeMd ?? false;
  const agentsMdIsForeign = present.foreignOutputs?.agentsMd ?? false;

  const targets: string[] = [];
  const gatedOut: MinskyCompileGatedTarget[] = [];

  const harnessGate = (target: string, output: string): MinskyCompileGatedTarget => ({
    target,
    kind: "harness",
    reason:
      `harness is "claude-code", which does not read ${output}, and ${output} does not ` +
      `already exist. Compile it explicitly with --target to opt in, or create ${output} ` +
      `once and it will be maintained from then on.`,
  });

  // mt#4986. Deliberately NOT phrased as "…does not exist": the file is right
  // there, which is what makes the old rule read its presence as consent.
  const foreignGate = (target: string, output: string): MinskyCompileGatedTarget => ({
    target,
    kind: "foreign",
    reason:
      `${output} exists but does not carry Minsky's generated-file banner, so it is treated ` +
      `as yours and is never overwritten. Move it aside and re-run to hand the file to Minsky.`,
  });

  if (present.skills) targets.push("claude-skills");
  if (present.rules) {
    if (!claudeCodeOnly || cursorRulesExists) targets.push("cursor-rules-ts");
    else gatedOut.push(harnessGate("cursor-rules-ts", ".cursor/rules"));

    // Foreign-ownership is checked BEFORE the harness gate, and unconditionally:
    // whose file it is does not depend on which harness the project runs.
    if (!claudeMdIsForeign) targets.push("claude.md");
    else gatedOut.push(foreignGate("claude.md", "CLAUDE.md"));

    if (agentsMdIsForeign) {
      gatedOut.push(foreignGate("agents.md", "AGENTS.md"));
    } else if (!claudeCodeOnly || agentsMdExists) {
      targets.push("agents.md");
    } else {
      gatedOut.push(harnessGate("agents.md", "AGENTS.md"));
    }

    targets.push("claude-rules");
  }
  if (present.agents) targets.push("claude-agents");
  if (present.hooks) targets.push("claude-hooks");

  return { targets, gatedOut };
}

/**
 * The harness recorded for this project, or `undefined` when none is.
 *
 * Reads `workspace.harness` from `.minsky/config.local.yaml` — the gitignored
 * machine-local overlay `performSetup` writes it to (`setup.ts`) — falling back to
 * the committed `.minsky/config.yaml` for projects that recorded it there.
 *
 * Deliberately a direct file read rather than a call into the configuration
 * system: this runs inside the compile probe, which is injectable-fs-only by
 * design (`MinskyCompileFsDeps`) so the target-selection tests stay hermetic.
 * Pulling the config loader in here would drag its own IO into that seam.
 *
 * Fails OPEN — any read or parse problem yields `undefined`, which means "no
 * harness recorded", which means the pre-mt#4866 target set. An unreadable config
 * must not silently STOP writing outputs a project depends on; the failure
 * direction is toward writing more, not less.
 */
export async function readRecordedHarness(
  workspacePath: string,
  fsDeps: MinskyCompileFsDeps
): Promise<string | undefined> {
  for (const fileName of ["config.local.yaml", "config.yaml"]) {
    try {
      const raw = await fsDeps.readFile(path.join(workspacePath, ".minsky", fileName), "utf-8");
      const parsed = parseYaml(raw) as { workspace?: { harness?: unknown } } | null;
      const harness = parsed?.workspace?.harness;
      if (typeof harness === "string" && harness.length > 0) return harness;
    } catch {
      // intentional-swallow: a missing or unparseable config is the common case
      // (most projects record no harness at all), and the fallback — undefined,
      // meaning "gate nothing" — is the safe direction. Nothing actionable is
      // lost: the next file is tried, and the caller's behaviour is unchanged.
    }
  }
  return undefined;
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
  return (await probeMinskyCompileTargetsWithGateReport(workspacePath, fsDeps)).targets;
}

/**
 * As {@link probeMinskyCompileTargets}, plus which targets the gates SKIPPED.
 *
 * Added by mt#4986 for the same reason `minskyCompileTargetsWithGateReport`
 * exists one layer down: the gate is otherwise invisible, and for a `"foreign"`
 * skip invisibility is the defect itself — the whole point is telling the
 * operator their file was left alone. `runMinskyCompile` dropped the report on
 * the floor, so a bare `minsky compile` in a project with its own `CLAUDE.md`
 * printed only the targets that DID run and said nothing about the one that
 * did not.
 */
export async function probeMinskyCompileTargetsWithGateReport(
  workspacePath: string,
  fsDeps: MinskyCompileFsDeps
): Promise<{ targets: string[]; gatedOut: MinskyCompileGatedTarget[] }> {
  const pathExists = async (candidate: string): Promise<boolean> => {
    try {
      await fsDeps.access(candidate);
      return true;
    } catch {
      return false;
    }
  };

  return minskyCompileTargetsWithGateReport({
    skills: await pathExists(path.join(workspacePath, ".minsky", "skills")),
    rules: await pathExists(path.join(workspacePath, ".minsky", "rules")),
    agents: await pathExists(path.join(workspacePath, ".minsky", "agents")),
    hooks: await pathExists(path.join(workspacePath, ".minsky", "hooks")),
    // mt#4866 SC3: the harness gate, plus the already-exists escape that keeps a
    // project already consuming these outputs from having them go stale.
    harness: await readRecordedHarness(workspacePath, fsDeps),
    existingOutputs: {
      cursorRules: await pathExists(path.join(workspacePath, ".cursor", "rules")),
      agentsMd: await pathExists(path.join(workspacePath, "AGENTS.md")),
    },
    // mt#4986 SC3: whose file is it. Read here, at the one place that already
    // touches the filesystem, so the pure mapping above stays testable without
    // fs stubbing — the same split `existingOutputs` already uses.
    foreignOutputs: {
      claudeMd: await isForeignMonolith(path.join(workspacePath, "CLAUDE.md"), fsDeps),
      agentsMd: await isForeignMonolith(path.join(workspacePath, "AGENTS.md"), fsDeps),
    },
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
    throw new Error(unknownCompileTargetMessage(targetId, compileService.getAvailableTargets()));
  }

  return compileService.compile(
    targetId,
    {
      workspacePath,
      outputPath: options.output,
      dryRun: options.dryRun,
      check: options.check,
      sizeBudget: options.sizeBudget,
      memoryLoadingMode: options.memoryLoadingMode,
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
  const { targets: probedTargets, gatedOut } = await probeMinskyCompileTargetsWithGateReport(
    workspacePath,
    fsDeps
  );
  const targetIds = probedTargets.length > 0 ? probedTargets : ["claude-skills"];

  // mt#4986 SC2. A target gated out as FOREIGN never runs, so its own refusal
  // never fires and `skippedForeignOutputs` would be empty — the operator would
  // be told nothing at all, which is the defect in a quieter form. Seed the
  // report from the gate instead. The `"harness"` kind is deliberately NOT
  // seeded here: that gate is normal narrowing, already documented, and not a
  // file anyone is protecting.
  const gateSkippedForeign: { path: string; reason: string }[] = [];
  for (const entry of gatedOut) {
    if (entry.kind !== "foreign") continue;
    // Explicit lookup, not a ternary (PR #3643 R1): a third monolithic target
    // would otherwise be silently reported against AGENTS.md — a wrong PATH in
    // an operator-facing message, which nothing type-checks. An unknown target
    // yields no entry rather than a fabricated one.
    const outputName = monolithicOutputName(entry.target);
    if (outputName === undefined) continue;
    // Re-reads the file rather than reconstructing the reason from the gate's
    // boolean: the reason has to name WHY (unreadable vs. hand-authored), and the
    // helper is the one place that pairs the read with the wording it licenses.
    const skip = await monolithicSkipIfNotOurs(path.join(workspacePath, outputName), fsDeps);
    if (skip !== undefined) gateSkippedForeign.push(skip);
  }

  const [onlyTargetId] = targetIds;
  if (targetIds.length === 1 && onlyTargetId) {
    const single = await compileSingleMinskyTarget(
      compileService,
      onlyTargetId,
      options,
      workspacePath
    );
    const merged = [...gateSkippedForeign, ...(single.skippedForeignOutputs ?? [])];
    return merged.length > 0 ? { ...single, skippedForeignOutputs: merged } : single;
  }

  const targets: MinskyCompileTargetOutcome[] = [];
  const filesWritten: string[] = [];
  const definitionsIncluded: string[] = [];
  const definitionsSkipped: string[] = [];
  const skippedForeignOutputs: { path: string; reason: string }[] = [...gateSkippedForeign];
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
    // mt#4986 SC2: concatenated like the other per-target arrays, so a caller
    // reading only the top-level result still learns a file was left alone.
    skippedForeignOutputs.push(...(single.skippedForeignOutputs ?? []));
  }

  return {
    target: targetIds.join(", "),
    filesWritten,
    definitionsIncluded,
    definitionsSkipped,
    skippedForeignOutputs: skippedForeignOutputs.length > 0 ? skippedForeignOutputs : undefined,
    check: options.check,
    stale: options.check ? overallStale : undefined,
    targets,
  };
}
