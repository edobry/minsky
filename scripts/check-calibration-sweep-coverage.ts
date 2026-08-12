#!/usr/bin/env bun
/**
 * Calibration-sweep reachability check — mt#3716 (SC3/SC5).
 *
 * Fails when a `.minsky/*-calibration.jsonl` file exists on disk that the
 * calibration sweep (`runSweep`, via `deriveCalibrationLogEntries`) would
 * not actually visit — keyed on SWEEP REACHABILITY, not on presence in a
 * declaration surface, so a log declared only as a
 * `GuardRegistration.calibrationLog` (write side, never read back before
 * this task) is caught too, not just a log declared nowhere at all.
 *
 * Usage:
 *   bun scripts/check-calibration-sweep-coverage.ts          # human-readable
 *   bun scripts/check-calibration-sweep-coverage.ts --json    # structured
 *
 * Exit code: 0 = every on-disk calibration log is swept; 1 = at least one is
 * not (named in the output).
 *
 * @see mt#3716 — this task
 * @see src/domain/calibration/calibration-sweep.ts — deriveCalibrationLogEntries, findUnsweptCalibrationLogs
 * @see scripts/lib/calibration-log-declarations.ts — the shared declaration accessor
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../.minsky/hooks/types";
import { getDeclaredCalibrationLogNames } from "./lib/calibration-log-declarations";
import {
  CALIBRATION_LOG_REGISTRY,
  deriveCalibrationLogEntries,
  findUnsweptCalibrationLogs,
} from "../src/domain/calibration/calibration-sweep";

const CALIBRATION_SUFFIX = "-calibration.jsonl";

function discoverOnDiskStems(repoRoot: string): string[] {
  const dir = join(repoRoot, ".minsky");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(CALIBRATION_SUFFIX))
    .map((n) => n.slice(0, -CALIBRATION_SUFFIX.length))
    .sort();
}

function main(): void {
  const json = process.argv.includes("--json");
  const repoRoot = findRepoRoot(process.cwd());
  const onDiskStems = discoverOnDiskStems(repoRoot);
  const sweptNames = new Set(
    deriveCalibrationLogEntries(getDeclaredCalibrationLogNames(), CALIBRATION_LOG_REGISTRY).map(
      (e) => e.name
    )
  );
  const unswept = findUnsweptCalibrationLogs(onDiskStems, sweptNames);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { checked: onDiskStems.length, sweptCount: sweptNames.size, unswept },
        null,
        2
      )}\n`
    );
  } else if (onDiskStems.length === 0) {
    console.log("No calibration logs found under .minsky/ — nothing to check.");
  } else if (unswept.length === 0) {
    console.log(
      `PASS — all ${onDiskStems.length} on-disk calibration log(s) are visited by the derived sweep.`
    );
  } else {
    console.log(
      `FAILED — ${unswept.length} on-disk calibration log(s) are NOT visited by the derived sweep:`
    );
    for (const stem of unswept) {
      console.log(`  - ${stem}-calibration.jsonl`);
    }
    console.log(
      "\nA calibration log's producer must declare `calibrationLog` on its GuardRegistration " +
        "(.minsky/hooks/registry.ts) or StandaloneGuardCanary (scripts/lib/standalone-guard-canaries.ts), " +
        "or be enumerated in NON_GUARD_CALIBRATION_PRODUCERS (scripts/lib/calibration-log-declarations.ts) " +
        "if it is written by something that is not a guard at all."
    );
  }

  process.exit(unswept.length === 0 ? 0 : 1);
}

main();
