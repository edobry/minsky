#!/usr/bin/env bun
/**
 * Per-test-file coverage against a PR's changed lines (mt#4779).
 *
 * A newly ADDED test file that executes NONE of the PR's changed lines is
 * vacuous by construction: it cannot have failed before the change, so it
 * carries no discriminating power about the change. That is detectable without
 * judgment, and this module is the pure core that detects it.
 *
 * ## Why coverage and not the import graph
 *
 * The cheap alternative is `scripts/find-related-tests.ts`'s reverse-dependency
 * graph: a test importing nothing that changed cannot execute changed lines.
 * Rejected on two independent grounds (mt#4423's planning audit has the full
 * record):
 *
 *   1. That graph is a "best-effort, regex-based import scanner, not a full
 *      TS/AST resolver" whose docblock accepts UNDER-inclusion, bounded at
 *      `DEFAULT_MAX_DEPTH = 3`. Under-inclusion means a test that DOES reach
 *      changed code via a missed edge reads as unreachable — a false positive,
 *      which is the wrong direction for a guard.
 *   2. It is a code-shape proxy for a behavioral question. The 2026-04-28
 *      incident memo that FILED this gate's ancestor (mt#1459) names exactly
 *      that substitution a category error: "only execution against the
 *      intended target proves it performs its detection function."
 *
 * So the signal is real coverage from a real run.
 *
 * ## Granularity, stated so it is not over-read
 *
 * Per test FILE, not per assertion. `bun test` exposes three coverage flags
 * (`--coverage`, `--coverage-reporter`, `--coverage-dir`) and no per-case
 * attribution, so per-case would mean an N-times re-run with `-t`. A test that
 * DOES execute changed lines but whose assertion is insensitive to them is NOT
 * detected here.
 */

/** Lines of a file, by repo-relative path. */
export type LineMap = Map<string, Set<number>>;

/**
 * Parse a unified diff into the set of ADDED lines per file.
 *
 * Added lines only: a deleted line has no post-image line number to intersect
 * coverage against, and coverage is measured on the post-image tree.
 *
 * Requires `--unified=0` in practice (context lines are counted correctly
 * either way, but zero context keeps the sets tight).
 */
export function parseChangedLines(diffText: string): LineMap {
  const changed: LineMap = new Map();
  let currentFile: string | null = null;
  let nextLineNo = 0;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      // `+++ b/path/to/file.ts`, or `+++ /dev/null` for a deletion.
      const target = raw.slice(4).trim();
      currentFile = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ")) continue;

    if (raw.startsWith("@@")) {
      // `@@ -old,count +new,count @@`
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (m?.[1] !== undefined) nextLineNo = Number(m[1]);
      continue;
    }

    if (currentFile === null) continue;

    if (raw.startsWith("+")) {
      let lines = changed.get(currentFile);
      if (!lines) {
        lines = new Set<number>();
        changed.set(currentFile, lines);
      }
      lines.add(nextLineNo);
      nextLineNo++;
    } else if (raw.startsWith(" ")) {
      nextLineNo++;
    }
    // A `-` line consumes no post-image line number.
  }

  return changed;
}

/**
 * Files ADDED by the diff (new-file mode), matching the test-file pattern.
 *
 * Scoped to ADDED, matching mt#1459's existing blocking floor: modifying an
 * existing test does not reach it. A modified test's discriminating power is
 * the negative-control question, owned separately (mt#4781).
 */
export function parseAddedTestFiles(diffText: string): string[] {
  const added: string[] = [];
  const lines = diffText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "new file mode 100644" && lines[i] !== "new file mode 100755") continue;
    // Walk back to the `diff --git a/x b/x` header this mode line belongs to.
    for (let j = i - 1; j >= 0; j--) {
      const header = lines[j];
      if (header === undefined) break;
      if (!header.startsWith("diff --git ")) continue;
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
      const path = m?.[2];
      if (path !== undefined && isTestFile(path)) added.push(path);
      break;
    }
  }

  return added;
}

/** The repo's test-file convention. Mirrors the runner's `*.test.ts(x)` glob. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path);
}

/**
 * Parse an lcov report into the set of COVERED lines per file (hit count > 0).
 *
 * `DA:<line>,<hits>` is the per-line record; `SF:<path>` opens a file section.
 * Paths are normalized to repo-relative by stripping a leading `repoRoot/`.
 */
export function parseLcovCoveredLines(lcovText: string, repoRoot = ""): LineMap {
  const covered: LineMap = new Map();
  let currentFile: string | null = null;
  const prefix = repoRoot.endsWith("/") ? repoRoot : repoRoot ? `${repoRoot}/` : "";

  for (const raw of lcovText.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const p = line.slice(3);
      currentFile = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
      continue;
    }
    if (line === "end_of_record") {
      currentFile = null;
      continue;
    }
    if (currentFile === null || !line.startsWith("DA:")) continue;

    const [lineNoRaw, hitsRaw] = line.slice(3).split(",");
    const lineNo = Number(lineNoRaw);
    const hits = Number(hitsRaw);
    if (!Number.isFinite(lineNo) || !Number.isFinite(hits) || hits <= 0) continue;

    let set = covered.get(currentFile);
    if (!set) {
      set = new Set<number>();
      covered.set(currentFile, set);
    }
    set.add(lineNo);
  }

  return covered;
}

/** One test file's verdict. Emitted for EVERY evaluation, fired or not. */
export interface CoverageEvaluation {
  /** The added test file this verdict is about. */
  testFile: string;
  /**
   * The SET of changed lines this test's run executed, per changed file
   * (sorted ascending). This is the primary output — SC1 asks for the set, and
   * a count alone cannot be checked against the diff by a reader.
   * Files with an empty intersection are omitted.
   */
  coveredChangedLines: Record<string, number[]>;
  /** Size of {@link coveredChangedLines}, summed. Derived, for quick reporting. */
  changedLinesCovered: number;
  /** Changed files it reached at least one line of, sorted for stable records. */
  reachedFiles: string[];
  /** Changed files it reached NO line of. */
  unreachedFiles: string[];
  /** True when the intersection is empty — the surfaced case. */
  vacuous: boolean;
}

/**
 * Intersect one test file's coverage with the PR's changed lines.
 *
 * Pure: takes both line maps and returns the verdict. No I/O, no clock, no
 * subprocess — so the surrounding runner's behaviour is testable without
 * patching anything it reaches.
 *
 * The test file's OWN lines are excluded from the intersection. A new test file
 * is itself a changed file, so counting its own executed lines would make every
 * test trivially non-vacuous — the check would then be unable to fail, which is
 * the defect it exists to detect (mem#704).
 */
export function evaluateCoverage(
  testFile: string,
  changedLines: LineMap,
  coveredLines: LineMap
): CoverageEvaluation {
  const reachedFiles: string[] = [];
  const unreachedFiles: string[] = [];
  const coveredChangedLines: Record<string, number[]> = {};
  let changedLinesCovered = 0;

  for (const [file, changed] of changedLines) {
    if (file === testFile) continue;
    if (isTestFile(file)) continue;

    const covered = coveredLines.get(file);
    const hitLines: number[] = [];
    if (covered) {
      for (const line of changed) {
        if (covered.has(line)) hitLines.push(line);
      }
    }

    if (hitLines.length > 0) {
      hitLines.sort((a, b) => a - b);
      coveredChangedLines[file] = hitLines;
      reachedFiles.push(file);
      changedLinesCovered += hitLines.length;
    } else {
      unreachedFiles.push(file);
    }
  }

  reachedFiles.sort();
  unreachedFiles.sort();

  return {
    testFile,
    coveredChangedLines,
    changedLinesCovered,
    reachedFiles,
    unreachedFiles,
    vacuous: changedLinesCovered === 0,
  };
}

/**
 * Collapse a sorted line list into ranges (`41-43,50`) so a wide intersection
 * stays readable in a CI log without losing which lines it names.
 */
export function formatLineRanges(lines: number[]): string {
  if (lines.length === 0) return "";
  const parts: string[] = [];
  let start = lines[0] as number;
  let prev = start;

  for (let i = 1; i <= lines.length; i++) {
    const current = lines[i];
    if (current !== undefined && current === prev + 1) {
      prev = current;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (current === undefined) break;
    start = current;
    prev = current;
  }

  return parts.join(",");
}

/**
 * Render a finding for a vacuous evaluation.
 *
 * Names the test AND the changed files it failed to reach — the second half is
 * what makes the finding actionable rather than an accusation.
 */
export function describeEvaluation(evaluation: CoverageEvaluation): string {
  if (!evaluation.vacuous) {
    // Name the LINES, not just the count: SC1 asks for the set, and a reader
    // checking this against the diff needs the line numbers to do it.
    const perFile = Object.entries(evaluation.coveredChangedLines)
      .map(([file, lines]) => `${file}:${formatLineRanges(lines)}`)
      .join("; ");
    return (
      `${evaluation.testFile}: executes ${evaluation.changedLinesCovered} changed line(s) ` +
      `across ${evaluation.reachedFiles.length} file(s) — ${perFile}`
    );
  }
  const targets = evaluation.unreachedFiles.length
    ? evaluation.unreachedFiles.join(", ")
    : "(no non-test files changed)";
  return (
    `${evaluation.testFile} executes NONE of this PR's changed lines. ` +
    `It cannot have failed before the change, so it carries no discriminating power about it. ` +
    `Changed files it does not reach: ${targets}`
  );
}
