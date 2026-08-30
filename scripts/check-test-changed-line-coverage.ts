#!/usr/bin/env bun
/**
 * CI runner for the per-test-file changed-line coverage check (mt#4779).
 *
 * For each test file the PR ADDS, run it with coverage and intersect the lines
 * it executed with the lines the PR changed. An empty intersection means the
 * test cannot have failed before the change.
 *
 * ## Why this runs in CI and not in the merge hook
 *
 * ADR-042's discriminator (scoped to the `/plan-task` battery, but the reasoning
 * transfers): a check earns a mechanical backstop where its STRUCTURED TRACE
 * first exists. The trace here is coverage data, which exists only once tests
 * RUN — so the merge-time PreToolUse hook would have to run the suite inside a
 * blocking tool call to get it. CI already runs tests; this rides there.
 *
 * ## Posture: log-only
 *
 * Calibration-first per ADR-032 — this surface's false-positive rate on this
 * repo is unmeasured, and flipping a guard to blocking is operator-reserved.
 * The process exits 0 on findings; it exits non-zero only when the check itself
 * could not run.
 *
 * ## It records EVERY evaluation, not only fires
 *
 * mt#4219 measured the sibling SC-coverage surface on this same gate: 434 gate
 * invocations, zero records written, and no way to tell "the condition never
 * held" from "a branch that cannot be reached". A fire-only log cannot
 * distinguish those. So every evaluation is recorded — including the
 * non-vacuous ones — which is the same remedy ADR-024's evaluation stream
 * adopted for the retrospective-trigger family.
 */

import { mkdtempSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execWithPath, findRepoRoot } from "../.minsky/hooks/types";
import { evaluationLogPath } from "../.minsky/hooks/dispatcher";
import {
  parseChangedLines,
  parseAddedTestFiles,
  parseLcovCoveredLines,
  evaluateCoverage,
  describeEvaluation,
  type CoverageEvaluation,
} from "./test-changed-line-coverage";

/** Evaluation-log base name; `evaluationLogPath` appends `-evaluations.jsonl`. */
export const EVALUATION_LOG_NAME = "test-changed-line-coverage";

interface RunnerOptions {
  /** Base ref to diff against. */
  base: string;
  /** Repo root; defaults to the cwd's root. */
  repoRoot?: string;
  /** Injected for tests — the record's timestamp (mt#4740: never read the clock inline). */
  nowMs?: number;
}

/** What one evaluation looks like on disk. */
export interface EvaluationRecord extends CoverageEvaluation {
  timestamp: string;
  base: string;
}

/**
 * Collect the diff once, then evaluate each added test file against it.
 *
 * Returns every evaluation, vacuous or not — the caller decides what to report
 * and what to record, and the record is the full set by design.
 */
export function runCoverageCheck(options: RunnerOptions): {
  evaluations: EvaluationRecord[];
  addedTestFiles: string[];
} {
  const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());
  const nowMs = options.nowMs ?? Date.now();

  const diffResult = execWithPath(
    ["git", "diff", "--unified=0", `${options.base}...HEAD`],
    // Well above the 10s default: a wide diff on a busy branch is slow to render.
    { cwd: repoRoot, timeout: 60_000 }
  );
  if (diffResult.exitCode !== 0) {
    throw new Error(
      `git diff against ${options.base} failed (exit ${diffResult.exitCode}): ${diffResult.stderr.trim()}`
    );
  }
  const diff = diffResult.stdout;
  const addedTestFiles = parseAddedTestFiles(diff);
  if (addedTestFiles.length === 0) return { evaluations: [], addedTestFiles };

  const changedLines = parseChangedLines(diff);
  const evaluations: EvaluationRecord[] = [];

  for (const testFile of addedTestFiles) {
    const coverageDir = mkdtempSync(join(tmpdir(), "mt4779-cov-"));
    // A test file that fails to run yields no lcov; that is reported as an
    // evaluation with zero coverage rather than crashing the check, because a
    // red test is CI's job to report, not this surface's.
    // The exit code is deliberately ignored: a FAILING test still emits coverage,
    // and a red test is CI's job to report, not this surface's. What matters here
    // is only which lines the run touched.
    execWithPath(
      [
        "bun",
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${coverageDir}`,
        testFile,
      ],
      { cwd: repoRoot, timeout: 120_000 }
    );

    const lcovPath = join(coverageDir, "lcov.info");
    const lcov = existsSync(lcovPath) ? readFileSync(lcovPath, "utf8") : "";
    const covered = parseLcovCoveredLines(lcov, repoRoot);

    evaluations.push({
      ...evaluateCoverage(testFile, changedLines, covered),
      timestamp: new Date(nowMs).toISOString(),
      base: options.base,
    });
  }

  return { evaluations, addedTestFiles };
}

/** Append every evaluation to the evaluation stream. */
export function recordEvaluations(records: EvaluationRecord[], repoRoot: string): string {
  const path = evaluationLogPath(EVALUATION_LOG_NAME, { projectDir: repoRoot });
  mkdirSync(dirname(path), { recursive: true });
  for (const record of records) {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  }
  return path;
}

function main(): void {
  const argv = process.argv.slice(2);
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : undefined;
  if (base === undefined || base.startsWith("--")) {
    console.error("Usage: bun scripts/check-test-changed-line-coverage.ts --base <ref>");
    process.exit(2);
  }

  const repoRoot = findRepoRoot(process.cwd());
  const { evaluations, addedTestFiles } = runCoverageCheck({ base, repoRoot });

  if (addedTestFiles.length === 0) {
    console.log("No test files added by this PR — nothing to evaluate.");
    process.exit(0);
  }

  const logPath = recordEvaluations(evaluations, repoRoot);
  const vacuous = evaluations.filter((e) => e.vacuous);

  for (const evaluation of evaluations) {
    console.log(
      `  ${evaluation.vacuous ? "VACUOUS" : "covers "} ${describeEvaluation(evaluation)}`
    );
  }
  console.log(`\nEvaluated ${evaluations.length} added test file(s); recorded to ${logPath}`);

  if (vacuous.length > 0) {
    // GitHub Actions surfaces `::warning::` inline on the PR. Log-only by
    // design — see the posture note in this file's header.
    for (const evaluation of vacuous) {
      console.log(`::warning file=${evaluation.testFile}::${describeEvaluation(evaluation)}`);
    }
  }
  process.exit(0);
}

if (import.meta.main) main();
