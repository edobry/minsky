#!/usr/bin/env bun
/**
 * mt#3059 — re-measures the AT-coverage calibration log
 * (`.minsky/execution-evidence-at-coverage-calibration.jsonl`) against the FIXED
 * acceptance-test extractor (FP-1: bound extraction to the next heading of ANY level;
 * FP-2: honor a superseding "Remaining/Updated/Revised/Current acceptance tests" heading),
 * to support the graduation decision from WARN-only to blocking.
 *
 * For each distinct task referenced in the log, re-fetches the task's CURRENT spec and
 * re-runs the fixed `parseAcceptanceTests` / `isExecutableAcceptanceTest` pipeline against
 * it. Compares the newly-extracted executable-AT set against what was logged at fire time:
 *
 *   - "eliminated": an AT flagged unaddressed at fire time whose text no longer appears
 *     among the newly-extracted executable ATs — an extraction-side false positive the
 *     fix removed (this is the FP-1/FP-2 signature).
 *   - "retained": an AT flagged unaddressed at fire time that STILL appears in the
 *     newly-extracted set. Extraction is unaffected by the fix for this item; whether it
 *     is a true unaddressed AT or a false positive from a DIFFERENT root cause (e.g. the
 *     evidence-text-matching side, out of this task's scope — see mem#719) is NOT
 *     re-evaluated here, since the log does not retain the original PR body.
 *   - "countChanged": the executable-AT COUNT for the task changed under the fix,
 *     independent of whether any specific flagged item's text matches — catches drift the
 *     text-match comparison alone could miss (e.g. renumbering, or extraction differences
 *     affecting ATs nobody flagged as unaddressed).
 *
 * Caveat (stated in the output, not just here): task specs can be edited after the fire
 * (rescoping, corrections, DONE-time write-ups). A "retained" or "countChanged"
 * classification reflects the CURRENT spec content, not necessarily the spec as it read at
 * fire time. This is the best available proxy without archived historical spec snapshots.
 *
 * Usage: bun scripts/at-coverage-reclassify.ts [--json] [--full]
 *
 * `--full` (mt#3316) additionally re-runs the EVIDENCE side against each flagged PR's real
 * body, and (mt#3339) partitions the still-flagged ATs into absent vs present-elsewhere.
 * Requires network access to fetch PR bodies; without it those pairs report UNDETERMINED
 * rather than being miscounted as unaddressed.
 * Exit code: always 0 (this is a report, not a pass/fail gate). Env: none required beyond
 * what the `minsky` CLI itself needs (DB connectivity) — see
 * `fetchTaskSpecForAtCoverage` in the hook module for the shell-out contract.
 */

import { existsSync, readFileSync } from "node:fs";
import { execWithPath, findRepoRoot } from "../.minsky/hooks/types";
import { fetchPrMetaByNumber } from "../.minsky/hooks/pr-context";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  AT_COVERAGE_STREAM,
  checkAcceptanceTestCoverage,
  deriveRepoFromGit,
  fetchTaskSpecForAtCoverage,
  isExecutableAcceptanceTest,
  parseAcceptanceTests,
} from "../.minsky/hooks/require-execution-evidence-before-merge";

interface CalibrationRecord {
  timestamp: string;
  task: string;
  prNumber: number;
  executableAtCount: number;
  unaddressedAts: { number: number; text: string }[];
}

interface FlaggedAt {
  number: number;
  text: string;
}

interface TaskReclassification {
  task: string;
  fireCount: number;
  prNumbers: number[];
  specFetchOk: boolean;
  oldMaxExecutableAtCount: number;
  newExecutableAtCount: number;
  countChanged: boolean;
  eliminated: FlaggedAt[];
  retained: FlaggedAt[];
}

function loadRecords(logPath: string): CalibrationRecord[] {
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const records: CalibrationRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip unparseable lines rather than crash the whole reclassification run.
    }
  }
  return records;
}

function reclassify(records: CalibrationRecord[], repoRoot: string): TaskReclassification[] {
  const byTask = new Map<string, CalibrationRecord[]>();
  for (const r of records) {
    const list = byTask.get(r.task) ?? [];
    list.push(r);
    byTask.set(r.task, list);
  }

  const results: TaskReclassification[] = [];

  for (const [task, taskRecords] of byTask) {
    const prNumbers = [...new Set(taskRecords.map((r) => r.prNumber))];
    const oldMaxExecutableAtCount = Math.max(...taskRecords.map((r) => r.executableAtCount));

    const specFetch = fetchTaskSpecForAtCoverage(task, repoRoot, execWithPath);
    if (!specFetch.ok || typeof specFetch.content !== "string") {
      results.push({
        task,
        fireCount: taskRecords.length,
        prNumbers,
        specFetchOk: false,
        oldMaxExecutableAtCount,
        newExecutableAtCount: -1,
        countChanged: false,
        eliminated: [],
        retained: [],
      });
      continue;
    }

    const allAts = parseAcceptanceTests(specFetch.content);
    const executableAts = allAts.filter((at) =>
      isExecutableAcceptanceTest(at.text, specFetch.kind)
    );
    const newExecutableAtCount = executableAts.length;
    const newTexts = new Set(executableAts.map((at) => at.text));

    // Union of every AT ever flagged unaddressed for this task, across all its fires,
    // deduped by text (the same AT can fire on repeated attempts against the same PR).
    const everFlagged = new Map<string, FlaggedAt>();
    for (const r of taskRecords) {
      for (const at of r.unaddressedAts) {
        everFlagged.set(at.text, at);
      }
    }

    const eliminated: FlaggedAt[] = [];
    const retained: FlaggedAt[] = [];
    for (const at of everFlagged.values()) {
      if (newTexts.has(at.text)) retained.push(at);
      else eliminated.push(at);
    }

    results.push({
      task,
      fireCount: taskRecords.length,
      prNumbers,
      specFetchOk: true,
      oldMaxExecutableAtCount,
      newExecutableAtCount,
      countChanged: oldMaxExecutableAtCount !== newExecutableAtCount,
      eliminated,
      retained,
    });
  }

  return results.sort((a, b) => a.task.localeCompare(b.task, undefined, { numeric: true }));
}

function printReport(results: TaskReclassification[]): void {
  const totalFires = results.reduce((n, r) => n + r.fireCount, 0);
  const withEliminations = results.filter((r) => r.eliminated.length > 0);
  const withRetained = results.filter((r) => r.retained.length > 0);
  const countChanged = results.filter((r) => r.countChanged);
  const fetchFailed = results.filter((r) => !r.specFetchOk);

  console.log(`AT-coverage calibration re-measurement (mt#3059 fixed extractor)`);
  console.log(`Distinct tasks in log: ${results.length}; total fires: ${totalFires}`);
  console.log(
    `Tasks with >=1 flagged AT ELIMINATED by the fix (extraction-side FP resolved): ${withEliminations.length}`
  );
  console.log(
    `Tasks with >=1 flagged AT RETAINED (extraction unaffected by the fix — status unknown w.r.t. evidence-matching): ${withRetained.length}`
  );
  console.log(
    `Tasks whose executable-AT COUNT changed under the fix (vs the count logged at fire time): ${countChanged.length}`
  );
  console.log(`Tasks whose current spec could not be fetched (skipped): ${fetchFailed.length}`);
  console.log("");

  for (const r of results) {
    if (!r.specFetchOk) {
      console.log(`  [SKIP] ${r.task} (PR #${r.prNumbers.join(",")}) — spec fetch failed`);
      continue;
    }
    const tags: string[] = [];
    if (r.eliminated.length > 0) tags.push(`ELIMINATED:${r.eliminated.length}`);
    if (r.retained.length > 0) tags.push(`RETAINED:${r.retained.length}`);
    if (r.countChanged) tags.push(`COUNT ${r.oldMaxExecutableAtCount}->${r.newExecutableAtCount}`);
    if (tags.length === 0) continue; // unchanged, nothing interesting to report per-task
    console.log(`  ${r.task} (PR #${r.prNumbers.join(",")}) — ${tags.join(", ")}`);
    for (const at of r.eliminated) {
      console.log(`      [eliminated] AT${at.number}: ${at.text.slice(0, 100)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// mt#3316 --full mode: also re-runs the EVIDENCE side (extractExecutionEvidenceText /
// checkAcceptanceTestCoverage against the PR's actual body), not just AT extraction.
//
// The extraction-only reclassify() above cannot detect an evidence-scanning false
// positive like FP-3 (mt#3174 / PR #2264) because the calibration log never retained the
// original PR body. This mode closes that gap by fetching each flagged PR's body directly
// from GitHub via `gh pr view` (mirrors the hook's own `fetchPrMetaByNumber`) — unlike a
// task spec, a merged PR's body is effectively immutable, so "current" body IS "body at
// fire time" for this purpose (no analogue to the CURRENT_SPEC_CAVEAT below applies here).
// ---------------------------------------------------------------------------

interface FullPrReclassification {
  task: string;
  prNumber: number;
  fireCount: number;
  specFetchOk: boolean;
  prBodyFetchOk: boolean;
  /**
   * Discriminated status for this (task, PR) pair's reclassification attempt. `"ok"` means
   * both fetches succeeded and `stillUnaddressed`/`resolvedByFix` reflect a real
   * classification. `"spec-fetch-failed"` / `"pr-body-fetch-failed"` mean the classification
   * could NOT be attempted — a fetch failure is an INFRASTRUCTURE outcome, never silently
   * recast as a content finding (mt#3316 PR #2410 R1 BLOCKING #2: "fail toward accusation" —
   * see `undetermined` below).
   */
  status: "ok" | "spec-fetch-failed" | "pr-body-fetch-failed";
  /** Union of every AT ever flagged unaddressed for this (task, PR) pair, across fires. */
  originallyFlagged: FlaggedAt[];
  /** Flagged ATs no longer unaddressed under the FULLY fixed pipeline (extraction + evidence-scan). Empty when `status !== "ok"` — see `undetermined`. */
  resolvedByFix: FlaggedAt[];
  /** Flagged ATs STILL unaddressed under the fully fixed pipeline — a real fire, or an FP with a different root cause. Empty when `status !== "ok"` — see `undetermined`. */
  stillUnaddressed: FlaggedAt[];
  /**
   * mt#3339 (FP-4): the SUBSET of `stillUnaddressed` whose AT number DOES appear somewhere
   * in the PR body, outside the block the scanner reads — a LOCATION gap rather than a
   * missing test. This is the partition that makes the still-flagged count interpretable:
   * without it, "N pairs still flagged" mixes real coverage gaps with evidence the author
   * did write but filed under a heading the extractor has no notion of. Empty when
   * `status !== "ok"`.
   */
  presentElsewhere: FlaggedAt[];
  /**
   * Flagged ATs whose true/false-positive status could NOT be determined this run because
   * the spec or PR-body fetch failed. NEVER populated together with `stillUnaddressed` for
   * the same pair — exactly one of the two carries `originallyFlagged`'s contents, so a
   * reader iterating `stillUnaddressed` alone (text mode's per-pair listing, or a JSON
   * consumer that doesn't check `status`) cannot mistake an unfetched pair for a confirmed
   * coverage gap.
   */
  undetermined: FlaggedAt[];
}

function reclassifyFull(
  records: CalibrationRecord[],
  repoRoot: string,
  repo: string | null
): FullPrReclassification[] {
  const byTaskPr = new Map<string, CalibrationRecord[]>();
  for (const r of records) {
    const key = `${r.task}::${r.prNumber}`;
    const list = byTaskPr.get(key) ?? [];
    list.push(r);
    byTaskPr.set(key, list);
  }

  const specCache = new Map<string, ReturnType<typeof fetchTaskSpecForAtCoverage>>();
  const results: FullPrReclassification[] = [];

  for (const taskRecords of byTaskPr.values()) {
    const first = taskRecords[0];
    if (!first) continue;
    const { task, prNumber } = first;

    const everFlagged = new Map<string, FlaggedAt>();
    for (const r of taskRecords) {
      for (const at of r.unaddressedAts) everFlagged.set(at.text, at);
    }
    const originallyFlagged = [...everFlagged.values()];

    let specFetch = specCache.get(task);
    if (!specFetch) {
      specFetch = fetchTaskSpecForAtCoverage(task, repoRoot, execWithPath);
      specCache.set(task, specFetch);
    }

    if (!specFetch.ok || typeof specFetch.content !== "string") {
      results.push({
        task,
        prNumber,
        fireCount: taskRecords.length,
        specFetchOk: false,
        prBodyFetchOk: false,
        status: "spec-fetch-failed",
        originallyFlagged,
        resolvedByFix: [],
        stillUnaddressed: [],
        presentElsewhere: [],
        undetermined: originallyFlagged,
      });
      continue;
    }

    const prMeta = repo ? fetchPrMetaByNumber(repo, prNumber, { cwd: repoRoot }) : null;
    if (!prMeta) {
      results.push({
        task,
        prNumber,
        fireCount: taskRecords.length,
        specFetchOk: true,
        prBodyFetchOk: false,
        status: "pr-body-fetch-failed",
        originallyFlagged,
        resolvedByFix: [],
        stillUnaddressed: [],
        presentElsewhere: [],
        undetermined: originallyFlagged,
      });
      continue;
    }

    const coverage = checkAcceptanceTestCoverage(specFetch.content, specFetch.kind, prMeta.body);
    const stillUnaddressedTexts = new Set(coverage.unaddressedAts.map((at) => at.text));
    const presentElsewhereTexts = new Set(coverage.presentElsewhereAts.map((at) => at.text));

    const resolvedByFix: FlaggedAt[] = [];
    const stillUnaddressed: FlaggedAt[] = [];
    const presentElsewhere: FlaggedAt[] = [];
    for (const at of originallyFlagged) {
      if (stillUnaddressedTexts.has(at.text)) {
        stillUnaddressed.push(at);
        // mt#3339: partition the still-flagged population. `presentElsewhere` is a SUBSET
        // of `stillUnaddressed`, not a sibling bucket — the AT is still unaddressed by the
        // gate's own definition; this only records that its evidence exists somewhere the
        // scanner does not read.
        if (presentElsewhereTexts.has(at.text)) presentElsewhere.push(at);
      } else resolvedByFix.push(at);
    }

    results.push({
      task,
      prNumber,
      fireCount: taskRecords.length,
      specFetchOk: true,
      prBodyFetchOk: true,
      status: "ok",
      originallyFlagged,
      resolvedByFix,
      stillUnaddressed,
      presentElsewhere,
      undetermined: [],
    });
  }

  return results.sort(
    (a, b) => a.task.localeCompare(b.task, undefined, { numeric: true }) || a.prNumber - b.prNumber
  );
}

function printFullReport(results: FullPrReclassification[]): void {
  const determined = results.filter((r) => r.status === "ok");
  const withStillUnaddressed = determined.filter((r) => r.stillUnaddressed.length > 0);
  const undeterminedPairs = results.filter((r) => r.status !== "ok");

  console.log(
    `\n--full re-measurement (mt#3316): re-runs the EVIDENCE side against each PR's real body`
  );
  console.log(`Distinct (task, PR) pairs: ${results.length}`);
  console.log(
    `Pairs with >=1 AT STILL unaddressed under the fully-fixed pipeline: ${withStillUnaddressed.length}`
  );
  console.log(
    `Pairs whose status could NOT be determined this run (spec or PR-body fetch failed — NOT counted as unaddressed): ${undeterminedPairs.length}`
  );

  // mt#3339 (FP-4): the absent-vs-present-elsewhere partition. Reported as counts of ATs,
  // not pairs, because a single pair can mix both kinds — and mixing them is precisely
  // what made the headline pair count uninterpretable before this split existed.
  const stillUnaddressedAtCount = determined.reduce((n, r) => n + r.stillUnaddressed.length, 0);
  const presentElsewhereAtCount = determined.reduce((n, r) => n + r.presentElsewhere.length, 0);
  const pairsWithPresentElsewhere = determined.filter((r) => r.presentElsewhere.length > 0);
  console.log(
    `Still-unaddressed ATs: ${stillUnaddressedAtCount}, of which ${presentElsewhereAtCount} are ` +
      `PRESENT-ELSEWHERE (referenced by number in the PR body, outside the scanned block — a ` +
      `location gap) across ${pairsWithPresentElsewhere.length} pair(s); the remaining ` +
      `${stillUnaddressedAtCount - presentElsewhereAtCount} are ABSENT (no reference anywhere).`
  );
  console.log("");

  for (const r of results) {
    if (r.status !== "ok") {
      console.log(
        `  [UNDETERMINED: ${r.status}] ${r.task} (PR #${r.prNumber}) — ${r.undetermined.length} AT(s) not re-checked`
      );
      continue;
    }
    if (r.stillUnaddressed.length === 0) continue;
    const presentElsewhereTexts = new Set(r.presentElsewhere.map((at) => at.text));
    console.log(`  ${r.task} (PR #${r.prNumber}) — ${r.stillUnaddressed.length} still unaddressed`);
    for (const at of r.stillUnaddressed) {
      const label = presentElsewhereTexts.has(at.text) ? "present-elsewhere" : "absent";
      console.log(`      [${label}] AT${at.number}: ${at.text.slice(0, 120)}`);
    }
  }
}

/**
 * Stated in every machine-readable output (not just this file's doc comment), per
 * PR #2386 R1 review: a consumer reading only the JSON — not this script's source — has
 * no other way to learn that "retained"/"countChanged" reflect the CURRENT spec, not the
 * spec as it read at fire time.
 */
const CURRENT_SPEC_CAVEAT =
  "Reclassification re-fetches each task's CURRENT spec content, not a historical " +
  "snapshot from fire time. A task whose spec was edited (rescoped, corrected, closed " +
  "out) after its fire(s) will be reclassified against today's content — 'retained' and " +
  "'countChanged' can therefore reflect spec drift unrelated to the extractor fix itself, " +
  "not only the fix's effect. See mt#3023 / mt#3223 in the mt#3059 spec's Re-measurement " +
  "section for confirmed instances of this caveat firing.";

function main() {
  const jsonMode = process.argv.includes("--json");
  const fullMode = process.argv.includes("--full");
  const repoRoot = findRepoRoot(process.cwd());
  // mt#4755 (PR #3541 R1): resolve through the WRITER's own resolver, not by joining the
  // repo-relative constant onto the repo root. Since this task routed the ladder through
  // `logCalibrationRecord`, the records live under the state dir — a repo-rooted read finds an
  // empty corpus and this script's own `records.length === 0` branch prints "No calibration
  // records found" and exits 0. That is a silent zero, indistinguishable from a detector that
  // never fired: the same shape mt#4811 found in `ask-form-lint` and mt#4784 tracks for
  // `check-coverage-receipts`.
  // The repo-relative constant is no longer imported here at all: it located the file, and
  // nothing else in this script used it.
  const logPath = calibrationLogPath(AT_COVERAGE_STREAM, { projectDir: repoRoot });
  const records = loadRecords(logPath);

  if (records.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ caveat: CURRENT_SPEC_CAVEAT, totalFires: 0, results: [] }));
    } else {
      console.log(`No calibration records found at ${logPath}.`);
    }
    process.exit(0);
  }

  const results = reclassify(records, repoRoot);
  const fullResults = fullMode
    ? reclassifyFull(records, repoRoot, deriveRepoFromGit(repoRoot))
    : null;

  if (jsonMode) {
    console.log(
      JSON.stringify(
        { caveat: CURRENT_SPEC_CAVEAT, totalFires: records.length, results, fullResults },
        null,
        2
      )
    );
  } else {
    console.log(`Caveat: ${CURRENT_SPEC_CAVEAT}\n`);
    printReport(results);
    if (fullResults) printFullReport(fullResults);
  }

  process.exit(0);
}

if (import.meta.main) main();
