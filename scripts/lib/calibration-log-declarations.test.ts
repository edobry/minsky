import { describe, test, expect } from "bun:test";
import {
  NON_GUARD_CALIBRATION_PRODUCERS,
  RETIRED_CALIBRATION_PRODUCERS,
  buildCalibrationLogToGuards,
  getDeclaredCalibrationLogNames,
} from "./calibration-log-declarations";
import { GUARD_REGISTRY } from "../../.minsky/hooks/registry";
import { STANDALONE_GUARD_CANARIES } from "./standalone-guard-canaries";

describe("getDeclaredCalibrationLogNames", () => {
  test("includes every GUARD_REGISTRY.calibrationLog name", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const reg of GUARD_REGISTRY) {
      if (!reg.calibrationLog) continue;
      for (const log of Array.isArray(reg.calibrationLog)
        ? reg.calibrationLog
        : [reg.calibrationLog]) {
        expect(declared.has(log)).toBe(true);
      }
    }
  });

  test("includes every STANDALONE_GUARD_CANARIES.calibrationLog name", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const canary of STANDALONE_GUARD_CANARIES) {
      if (!canary.calibrationLog) continue;
      for (const log of Array.isArray(canary.calibrationLog)
        ? canary.calibrationLog
        : [canary.calibrationLog]) {
        expect(declared.has(log)).toBe(true);
      }
    }
  });

  test("includes the enumerated non-guard producers (ask-form-lint)", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const name of Object.keys(NON_GUARD_CALIBRATION_PRODUCERS)) {
      expect(declared.has(name)).toBe(true);
    }
  });

  test("includes the enumerated retired producers (mt#4204)", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const name of Object.keys(RETIRED_CALIBRATION_PRODUCERS)) {
      expect(declared.has(name)).toBe(true);
    }
  });
});

describe("RETIRED_CALIBRATION_PRODUCERS (mt#4204)", () => {
  test("a retired producer's log has no live guard declaring it", () => {
    // The defining property: the producer is GONE from the tree. If a guard or canary still
    // declared this log, the entry would be wrong — the log would have real invocation evidence
    // and belongs in the ordinary coverage path, not the retired category. This is what keeps
    // the map from becoming a mute for a detector that has merely gone quiet.
    const map = buildCalibrationLogToGuards();
    for (const name of Object.keys(RETIRED_CALIBRATION_PRODUCERS)) {
      expect(map.has(name)).toBe(false);
    }
  });

  test("a retired producer is not also declared non-guard", () => {
    // The two categories are exclusive by construction: non-guard means "written by something
    // that is not a hook", retired means "written by nothing at all". A name in both would make
    // the consumer's exclusion order load-bearing, which it should never be.
    for (const name of Object.keys(RETIRED_CALIBRATION_PRODUCERS)) {
      expect(name in NON_GUARD_CALIBRATION_PRODUCERS).toBe(false);
    }
  });

  test("every entry names its retiring task, so the claim is auditable", () => {
    // A bare "retired" with no provenance is indistinguishable from a mute someone added to
    // silence an inconvenient FLAGGED row. The task id is what makes it checkable.
    for (const [name, producer] of Object.entries(RETIRED_CALIBRATION_PRODUCERS)) {
      expect(producer, name).toMatch(/mt#\d+/);
    }
  });

  test("includes the three post-2026-08-05 write-declared-only detectors this task's amendment names", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const name of [
      "agent-dispatch-record",
      "chained-verification-commands",
      "duplicate-signature-scan",
    ]) {
      expect(declared.has(name)).toBe(true);
    }
  });

  test("is sorted and has no duplicates", () => {
    const declared = getDeclaredCalibrationLogNames();
    expect(declared).toEqual([...new Set(declared)].sort());
  });
});

describe("buildCalibrationLogToGuards", () => {
  test("maps a dispatcher-registered log to its guard name", () => {
    const map = buildCalibrationLogToGuards();
    expect(map.get("agent-dispatch-record")).toEqual(["record-agent-dispatch"]);
  });

  test("maps a standalone-canary-declared log to its guard name", () => {
    const map = buildCalibrationLogToGuards();
    // block-git-gh-cli is a standalone guard per scripts/lib/standalone-guard-canaries.ts;
    // this asserts SOME standalone canary's calibrationLog (if any is declared)
    // resolves through this map rather than only GUARD_REGISTRY entries.
    const anyStandaloneDeclared = STANDALONE_GUARD_CANARIES.some((c) => c.calibrationLog);
    if (!anyStandaloneDeclared) return; // nothing to assert if none currently declare one
    for (const canary of STANDALONE_GUARD_CANARIES) {
      if (!canary.calibrationLog) continue;
      const logs = Array.isArray(canary.calibrationLog)
        ? canary.calibrationLog
        : [canary.calibrationLog];
      for (const log of logs) {
        expect(map.get(log)).toContain(canary.guardName);
      }
    }
  });
});

// AC3 ("Run the calibration sweep -> every log it reports on is one of the
// declared set, and every declared log is visited") is exercised operationally
// by `bun scripts/check-coverage-receipts.ts` and by
// `mcp__minsky__observability_calibration-review`, not by a real-filesystem
// unit test here (`custom/no-real-fs-in-tests` forbids that pattern; the
// pure-logic equivalent — `findUnsweptCalibrationLogs` against synthetic
// on-disk stems — is tested in
// `src/domain/calibration/calibration-sweep-registry-derivation.test.ts`).
