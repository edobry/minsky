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
 * Usage: bun scripts/at-coverage-reclassify.ts [--json]
 * Exit code: always 0 (this is a report, not a pass/fail gate). Env: none required beyond
 * what the `minsky` CLI itself needs (DB connectivity) — see
 * `fetchTaskSpecForAtCoverage` in the hook module for the shell-out contract.
 */

import { existsSync, readFileSync } from "node:fs";
import { execWithPath, findRepoRoot } from "../.minsky/hooks/types";
import {
  AT_COVERAGE_CALIBRATION_LOG,
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

function main() {
  const jsonMode = process.argv.includes("--json");
  const repoRoot = findRepoRoot(process.cwd());
  const logPath = `${repoRoot}/${AT_COVERAGE_CALIBRATION_LOG}`;
  const records = loadRecords(logPath);

  if (records.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ totalFires: 0, results: [] }));
    } else {
      console.log(`No calibration records found at ${logPath}.`);
    }
    process.exit(0);
  }

  const results = reclassify(records, repoRoot);

  if (jsonMode) {
    console.log(JSON.stringify({ totalFires: records.length, results }, null, 2));
  } else {
    printReport(results);
  }

  process.exit(0);
}

if (import.meta.main) main();
