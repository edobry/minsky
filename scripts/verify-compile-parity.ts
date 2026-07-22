#!/usr/bin/env bun
/**
 * Compile-pipeline parity harness (mt#2992, Phase 1 of ADR-016 convergence).
 *
 * Compares the new `compile` system's `claude.md` / `agents.md` /
 * `claude-rules` targets against the legacy `rules compile` system's
 * implementations, on the LIVE `.minsky/rules/` corpus, asserting:
 *
 * 1. **Source breadth** — neither `.cursor/rules/` nor `.ai/rules/`
 *    contributes a rule ID absent from `.minsky/rules/` (spec `## Source
 *    breadth`). If this ever stops holding, the new reader (which scans
 *    `.minsky/rules/` ONLY) would silently miss a rule legacy's fallback
 *    scan picks up — this check fails loudly instead.
 * 2. **No data loss (validation strictness)** — the new reader (stricter
 *    schema; skip+warn on invalid rules) must not skip any rule the legacy
 *    `RuleService` (no schema validation) successfully includes (spec
 *    `## Validation strictness`). HARD-FAILS on any mismatch — this is not
 *    a warning.
 * 3. **claude.md / agents.md parity** — identical rule-ID membership
 *    (implies identical always-apply filtering, since both systems derive
 *    `rulesIncluded`/`definitionsIncluded` FROM that classification),
 *    identical size-budget evaluation (`sizeChars`, `sizeBudgetStatus`), and
 *    identical content modulo rule ORDER (sorted-line-multiset equality —
 *    byte-parity is explicitly not a goal per the spec's `## Summary`).
 * 4. **claude-rules parity** — identical eligible-rule-ID set, and
 *    byte-identical per-file content for each rule present on both sides
 *    (a single rule's serialized file has no internal "order" to diverge on,
 *    unlike the monolithic targets).
 *
 * Usage: `bun scripts/verify-compile-parity.ts [--workspace <path>]`
 * Exit code: 0 if every check passes, 1 otherwise. Always prints a
 * structured JSON report to stdout (one line summary to stderr for
 * at-a-glance reading) — no files are written or modified; this is a
 * read-only comparison against the live corpus.
 */

import "reflect-metadata";
import realFs from "fs/promises";
import { join } from "path";

import { RuleService } from "@minsky/domain/rules";
import { compileRules } from "@minsky/domain/rules/rules-command-operations";
import type { CompileRulesResult } from "@minsky/domain/rules/rules-command-operations";
import { runMinskyCompile } from "@minsky/domain/compile/compile";
import type { MinskyCompileServiceResult } from "@minsky/domain/compile/compile-service";
import { loadAdaptedRules } from "@minsky/domain/compile/targets/rule-loader";
import type { MinskyCompileFsDeps } from "@minsky/domain/compile/types";
import { hasSizeBudgetFields } from "@minsky/domain/compile/size-budget-report";
import { buildClaudeRulesContent as legacyBuildClaudeRulesContent } from "@minsky/domain/rules/compile/targets/claude-rules";
import { buildClaudeRulesContent as newBuildClaudeRulesContent } from "@minsky/domain/compile/targets/claude-rules";
import { claudeRulesTarget as legacyClaudeRulesTarget } from "@minsky/domain/rules/compile/targets/claude-rules";

interface CheckResult {
  name: string;
  pass: boolean;
  details?: unknown;
}

function parseArgs(argv: string[]): { workspace: string } {
  const idx = argv.indexOf("--workspace");
  const workspace = idx !== -1 && argv[idx + 1] ? argv[idx + 1] : process.cwd();
  return { workspace };
}

async function listMdcIds(dir: string): Promise<Set<string>> {
  try {
    const entries = await realFs.readdir(dir);
    return new Set(
      entries.filter((e) => e.endsWith(".mdc")).map((e) => e.slice(0, -".mdc".length))
    );
  } catch {
    // Directory doesn't exist — zero contribution, trivially passes.
    return new Set();
  }
}

/** Check 1: source-breadth invariant (spec `## Source breadth`). */
async function checkSourceBreadth(workspacePath: string): Promise<CheckResult> {
  const minskyIds = await listMdcIds(join(workspacePath, ".minsky", "rules"));
  const cursorIds = await listMdcIds(join(workspacePath, ".cursor", "rules"));
  const aiIds = await listMdcIds(join(workspacePath, ".ai", "rules"));

  const cursorOnly = [...cursorIds].filter((id) => !minskyIds.has(id));
  const aiOnly = [...aiIds].filter((id) => !minskyIds.has(id));

  return {
    name: "source-breadth: .cursor/rules/ and .ai/rules/ contribute no rule ID absent from .minsky/rules/",
    pass: cursorOnly.length === 0 && aiOnly.length === 0,
    details: { minskyCount: minskyIds.size, cursorOnly, aiOnly },
  };
}

/**
 * Check 2: no-data-loss / validation-strictness invariant (spec
 * `## Validation strictness`). HARD-FAILS if the new reader would skip any
 * rule the legacy (unvalidated) RuleService includes.
 */
async function checkNoDataLoss(workspacePath: string): Promise<CheckResult> {
  const ruleService = new RuleService(workspacePath);
  const legacyRules = await ruleService.listRules({});
  const legacyIds = new Set(legacyRules.map((r) => r.id));

  const skippedWarnings: string[] = [];
  const newRules = await loadAdaptedRules(workspacePath, realFs as MinskyCompileFsDeps, (message) =>
    skippedWarnings.push(message)
  );
  const newIds = new Set(newRules.map((r) => r.id));

  const missingFromNewReader = [...legacyIds].filter((id) => !newIds.has(id));

  return {
    name: "validation-strictness: new reader must not skip any rule legacy includes (data-loss guard)",
    pass: missingFromNewReader.length === 0,
    details: {
      legacyCount: legacyIds.size,
      newReaderCount: newIds.size,
      missingFromNewReader,
      skippedWarnings,
    },
  };
}

/** Sorted-line-multiset equality — the "modulo rule ORDER" content comparator. */
function contentEqualModuloOrder(a: string | undefined, b: string | undefined): boolean {
  const aLines = (a ?? "").split("\n").sort();
  const bLines = (b ?? "").split("\n").sort();
  if (aLines.length !== bLines.length) return false;
  for (let i = 0; i < aLines.length; i++) {
    if (aLines[i] !== bLines[i]) return false;
  }
  return true;
}

/** Check 3: claude.md / agents.md parity — membership, size-budget, content-modulo-order. */
async function checkMonolithicTargetParity(
  workspacePath: string,
  target: "claude.md" | "agents.md"
): Promise<CheckResult> {
  const legacy: CompileRulesResult = await compileRules({ workspacePath, target, dryRun: true });
  const fresh: MinskyCompileServiceResult = await runMinskyCompile({
    workspacePath,
    target,
    dryRun: true,
  });

  const legacySet = new Set(legacy.rulesIncluded ?? []);
  const freshSet = new Set(fresh.definitionsIncluded ?? []);
  const onlyInLegacy = [...legacySet].filter((id) => !freshSet.has(id));
  const onlyInNew = [...freshSet].filter((id) => !legacySet.has(id));
  const membershipMatch = onlyInLegacy.length === 0 && onlyInNew.length === 0;

  // `fresh` carries the size-budget extension fields structurally (see
  // packages/domain/src/compile/size-budget-report.ts) even though the
  // static MinskyCompileServiceResult type doesn't declare them — narrow
  // with the SAME type guard the compile CLI uses rather than an ad-hoc cast.
  const freshBudget = hasSizeBudgetFields(fresh)
    ? { sizeChars: fresh.sizeChars, sizeBudgetStatus: fresh.sizeBudgetStatus }
    : { sizeChars: undefined, sizeBudgetStatus: undefined };
  const sizeMatch =
    legacy.sizeChars === freshBudget.sizeChars &&
    legacy.sizeBudgetStatus === freshBudget.sizeBudgetStatus;

  const contentMatch = contentEqualModuloOrder(legacy.content, fresh.content);

  return {
    name: `${target}: rule-ID membership (implies always-apply filtering), size-budget evaluation, content modulo order`,
    pass: membershipMatch && sizeMatch && contentMatch,
    details: {
      membershipMatch,
      onlyInLegacy,
      onlyInNew,
      sizeMatch,
      legacy: { sizeChars: legacy.sizeChars, sizeBudgetStatus: legacy.sizeBudgetStatus },
      fresh: freshBudget,
      contentMatch,
    },
  };
}

/**
 * Check 4: claude-rules parity — identical eligible-rule-ID set and
 * byte-identical per-file content for every rule present on both sides.
 * Calls each side's own `buildClaudeRulesContent` directly (rather than
 * reverse-parsing the dry-run summary string) so per-file content can be
 * compared by rule id, independent of absolute output-path prefixes.
 */
async function checkClaudeRulesParity(workspacePath: string): Promise<CheckResult> {
  const ruleService = new RuleService(workspacePath);
  const legacyRules = await ruleService.listRules({});
  const newRules = await loadAdaptedRules(workspacePath, realFs as MinskyCompileFsDeps);

  const outputDir = legacyClaudeRulesTarget.defaultOutputPath(workspacePath);
  const legacyBuilt = legacyBuildClaudeRulesContent(legacyRules, outputDir);
  const newBuilt = newBuildClaudeRulesContent(newRules, outputDir);

  const legacySet = new Set(legacyBuilt.rulesIncluded);
  const newSet = new Set(newBuilt.rulesIncluded);
  const onlyInLegacy = [...legacySet].filter((id) => !newSet.has(id));
  const onlyInNew = [...newSet].filter((id) => !legacySet.has(id));
  const membershipMatch = onlyInLegacy.length === 0 && onlyInNew.length === 0;

  const legacyById = new Map(legacyBuilt.files.map((f) => [ruleIdFromFilePath(f.path), f.content]));
  const newById = new Map(newBuilt.files.map((f) => [ruleIdFromFilePath(f.path), f.content]));

  const contentMismatches: string[] = [];
  for (const id of legacySet) {
    if (!newSet.has(id)) continue; // already reported as a membership mismatch
    if (legacyById.get(id) !== newById.get(id)) {
      contentMismatches.push(id);
    }
  }

  return {
    name: "claude-rules: eligible-rule-ID membership + byte-identical per-file content",
    pass: membershipMatch && contentMismatches.length === 0,
    details: {
      fileCount: legacyBuilt.files.length,
      membershipMatch,
      onlyInLegacy,
      onlyInNew,
      contentMismatches,
    },
  };
}

function ruleIdFromFilePath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  return basename.endsWith(".md") ? basename.slice(0, -".md".length) : basename;
}

async function main(): Promise<number> {
  const { workspace } = parseArgs(process.argv.slice(2));

  const checks: CheckResult[] = [];
  checks.push(await checkSourceBreadth(workspace));
  checks.push(await checkNoDataLoss(workspace));
  checks.push(await checkMonolithicTargetParity(workspace, "claude.md"));
  checks.push(await checkMonolithicTargetParity(workspace, "agents.md"));
  checks.push(await checkClaudeRulesParity(workspace));

  const failed = checks.filter((c) => !c.pass);
  const pass = failed.length === 0;

  const report = {
    tool: "verify-compile-parity",
    task: "mt#2992",
    workspace,
    pass,
    checkCount: checks.length,
    failedCount: failed.length,
    checks,
  };

  console.log(JSON.stringify(report, null, 2));
  console.error(
    pass
      ? `✅ compile-parity: all ${checks.length} checks passed`
      : `❌ compile-parity: ${failed.length}/${checks.length} check(s) failed: ${failed.map((f) => f.name).join("; ")}`
  );

  return pass ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error("verify-compile-parity crashed:", error);
      process.exit(1);
    });
}

export {
  checkSourceBreadth,
  checkNoDataLoss,
  checkMonolithicTargetParity,
  checkClaudeRulesParity,
  contentEqualModuloOrder,
};
