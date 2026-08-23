import { describe, test, expect } from "bun:test";
import {
  NON_GUARD_CALIBRATION_PRODUCERS,
  RETIRED_CALIBRATION_PRODUCERS,
  buildCalibrationLogToGuards,
  getDeclaredCalibrationLogNames,
} from "./calibration-log-declarations";
import { GUARD_REGISTRY } from "../../.minsky/hooks/registry";
import { STANDALONE_GUARD_CANARIES } from "./standalone-guard-canaries";
import { AT_COVERAGE_CALIBRATION_LOG } from "../../.minsky/hooks/require-execution-evidence-before-merge";
import { TEST_FIRST_CALIBRATION_LOG } from "../../.minsky/hooks/test-first-evidence";
import { RENDER_PATH_CALIBRATION_LOG } from "../../.minsky/hooks/render-path-evidence";
import { SC_COVERAGE_CALIBRATION_LOG } from "../../.minsky/hooks/success-criteria-coverage";
import {
  CALIBRATION_LOG as GATE_WALK_CALIBRATION_LOG,
  GUARD_NAME as GATE_WALK_GUARD_NAME,
} from "../../.minsky/hooks/gate-walk-provenance";

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

describe("gate-walk-provenance's declaration (mt#4390)", () => {
  // Bound to the WRITER CONSTANT, following mt#4064's precedent above: a
  // hand-copied string would keep passing through a rename, which is the whole
  // failure mode this guard just demonstrated at a different layer.
  const stem = GATE_WALK_CALIBRATION_LOG.replace(/^\.minsky\//, "").replace(
    /-calibration\.jsonl$/,
    ""
  );

  test("its log resolves to the guard that writes it", () => {
    // Before this task the guard was wired ONLY in `.claude/settings.json` — a
    // third wiring shape, present in neither declaration surface — so this
    // lookup returned undefined and the coverage receipt could only ever FLAG.
    expect(buildCalibrationLogToGuards().get(stem)).toContain(GATE_WALK_GUARD_NAME);
  });

  test("the declared name matches the guard's own GUARD_NAME", () => {
    // The join is by NAME, and the fire log is written under GUARD_NAME. A
    // declaration naming anything else would resolve here and still find zero
    // invocations — the shape mt#4068 tracks on a different surface.
    const canary = STANDALONE_GUARD_CANARIES.find((c) => c.guardName === GATE_WALK_GUARD_NAME);
    expect(canary).toBeDefined();
    expect(canary?.calibrationLog).toBe(stem);
  });

  test("it is declared on exactly one surface, not both", () => {
    // `buildCalibrationLogToGuards` unions GUARD_REGISTRY and the canaries, so a
    // double declaration is silently tolerated and then shows up as a duplicate
    // guard name in the joined list.
    const inRegistry = GUARD_REGISTRY.filter((r) => r.name === GATE_WALK_GUARD_NAME);
    expect(inRegistry).toEqual([]);
    expect(buildCalibrationLogToGuards().get(stem)).toEqual([GATE_WALK_GUARD_NAME]);
  });
});

describe("the execution-evidence merge gate's four calibration logs (mt#4064)", () => {
  // Keyed off the WRITER CONSTANTS rather than hand-copied strings, because this one guard's
  // declaration has now been incomplete twice in the same way: mt#3519 widened `calibrationLog`
  // to accept a list precisely because the gate writes more than one log, and enumerated two of
  // the four. Binding to the constants means renaming a log breaks this at the rename.
  const GATE_LOGS: readonly (readonly [string, string])[] = [
    ["AT_COVERAGE_CALIBRATION_LOG", AT_COVERAGE_CALIBRATION_LOG],
    ["TEST_FIRST_CALIBRATION_LOG", TEST_FIRST_CALIBRATION_LOG],
    ["RENDER_PATH_CALIBRATION_LOG", RENDER_PATH_CALIBRATION_LOG],
    ["SC_COVERAGE_CALIBRATION_LOG", SC_COVERAGE_CALIBRATION_LOG],
  ];

  const stem = (logPath: string): string =>
    logPath.replace(/^\.minsky\//, "").replace(/-calibration\.jsonl$/, "");

  test("every log the gate writes is declared", () => {
    const declared = new Set(getDeclaredCalibrationLogNames());
    for (const [constant, logPath] of GATE_LOGS) {
      expect(declared.has(stem(logPath)), constant).toBe(true);
    }
  });

  test("every log the gate writes resolves back to the gate", () => {
    // The mem#812 axis: a declaration widened from one-to-N leaves the old cardinality alive in
    // whatever map INVERTS it, silently and with no type error. Two-to-four is the same widening,
    // so assert each log resolves to the guard individually rather than trusting a list length.
    const map = buildCalibrationLogToGuards();
    for (const [constant, logPath] of GATE_LOGS) {
      expect(map.get(stem(logPath)), constant).toContain("require-execution-evidence-before-merge");
    }
  });

  test("the four log names are pinned, so a rename cannot pass silently", () => {
    // Also the scope statement for the two tests above: they bind the four constants that exist
    // today, so a FIFTH surface added to this gate would pass them. For a log that lands on disk
    // the backstop is `scripts/check-calibration-sweep-coverage.ts`, which fails when an existing
    // `.minsky/*-calibration.jsonl` is visited by no sweep — that is how mt#4064's render-path gap
    // was surfaced. The case with no backstop is a log declared nowhere AND never yet written, as
    // `-sc-coverage` was: absent from disk, so invisible to every glob-driven check until it fires.
    expect(GATE_LOGS.map(([, logPath]) => stem(logPath))).toEqual([
      "execution-evidence-at-coverage",
      "execution-evidence-test-first",
      "execution-evidence-render-path",
      "execution-evidence-sc-coverage",
    ]);
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
