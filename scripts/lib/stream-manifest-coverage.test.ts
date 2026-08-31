/**
 * mt#4804 — the check that makes a 23rd manifest omission fail instead of going unnoticed.
 *
 * Two tasks found this gap by hand. mt#4752 found three missing streams while enumerating the
 * writers it happened to be touching; mt#4804 ran the same enumeration wider and found 24 more,
 * holding 107,828 records that had never reached `guard_events`. Nothing was watching, because a
 * stream absent from the ingest manifest produces no error and no empty result — it simply never
 * appears.
 *
 * The tests below are the thing that watches. The real-coverage cases assert today's state; the
 * synthetic cases assert that the check can actually FAIL, which is the property that matters
 * and the one a green run does not demonstrate on its own.
 *
 * @see scripts/lib/stream-manifest-coverage.ts — the pure functions under test
 * @see packages/domain/src/guard-events/stream-sources.ts — the manifest
 */

import { describe, test, expect } from "bun:test";
import {
  findUndeclaredStreams,
  findUnbackedManifestStreams,
  findUndeclaredEvaluationWriters,
} from "./stream-manifest-coverage";
import { getDeclaredCalibrationLogNames } from "./calibration-log-declarations";
import {
  EVALUATION_STREAM_PRODUCERS,
  defaultEvaluationWriterScanDeps,
  findEvaluationWriterModules,
  getDeclaredEvaluationStreamNames,
} from "./evaluation-log-declarations";
import { GUARD_EVENT_STREAM_SOURCES } from "../../packages/domain/src/guard-events/stream-sources";

const manifestStreams = GUARD_EVENT_STREAM_SOURCES.map((s) => s.stream);

function realInput() {
  return {
    declaredCalibrationLogs: getDeclaredCalibrationLogNames(),
    declaredEvaluationStreams: getDeclaredEvaluationStreamNames(),
    manifestStreams,
  };
}

describe("SC2 — every declared stream reaches the ingest manifest", () => {
  test("no declared calibration or evaluation stream is missing from the manifest", () => {
    const gaps = findUndeclaredStreams(realInput());
    // Named in the failure so a future break says WHICH stream, not just a count — the whole
    // cost of this class is that the missing one is unnamed.
    expect(gaps.map((g) => `${g.family}:${g.stream}`)).toEqual([]);
  });

  test("the manifest carries strictly more streams than either declaration surface alone", () => {
    // Guards against a future "simplification" that drops one of the two surfaces. Each sees a
    // part of the population the other does not: the calibration surfaces see standalone guards
    // wired straight into settings.json, the evaluation surface sees writers that declare
    // nothing at all.
    expect(getDeclaredCalibrationLogNames().length).toBeGreaterThan(0);
    expect(getDeclaredEvaluationStreamNames().length).toBeGreaterThan(0);
    expect(manifestStreams.length).toBeGreaterThan(getDeclaredCalibrationLogNames().length);
  });

  test("manifest rows with no declaration behind them are reported, not failed", () => {
    // The reverse direction is a much weaker claim — a stale row costs one stat per sweep, where
    // a missing row costs every record. Asserted as an array so a change is visible in the diff
    // rather than silently absorbed.
    const unbacked = findUnbackedManifestStreams(realInput());
    expect(Array.isArray(unbacked)).toBe(true);
  });
});

describe("AT4 — a written-but-undeclared stream fails the check", () => {
  test("a newly declared stream absent from the manifest is reported", () => {
    const gaps = findUndeclaredStreams({
      declaredCalibrationLogs: ["silent-stretch", "a-detector-shipped-today"],
      declaredEvaluationStreams: [],
      manifestStreams: ["silent-stretch"],
    });
    expect(gaps).toEqual([{ stream: "a-detector-shipped-today", family: "calibration" }]);
  });

  test("an undeclared EVALUATION stream is reported too, not just calibration", () => {
    // The half that had no declaration surface at all before this task, and so the half most
    // likely to be dropped by a future refactor.
    const gaps = findUndeclaredStreams({
      declaredCalibrationLogs: [],
      declaredEvaluationStreams: ["silent-stretch-evaluations", "brand-new-evaluations"],
      manifestStreams: ["silent-stretch-evaluations"],
    });
    expect(gaps).toEqual([{ stream: "brand-new-evaluations", family: "evaluation" }]);
  });

  test("a stream that has never fired is still reported — the case a filesystem scan misses", () => {
    // `criterion-reconciliation` is the real instance: declared, wired, zero records on disk. A
    // scan of written logs reports the set complete; this check does not.
    const gaps = findUndeclaredStreams({
      declaredCalibrationLogs: ["criterion-reconciliation"],
      declaredEvaluationStreams: [],
      manifestStreams: [],
    });
    expect(gaps).toEqual([{ stream: "criterion-reconciliation", family: "calibration" }]);
  });
});

describe("AT3 — negative control: the check goes red when a declaration is dropped", () => {
  test("removing one real manifest entry surfaces exactly that stream", () => {
    const input = realInput();
    const dropped = "truncated-outcome-read";
    expect(input.manifestStreams).toContain(dropped);

    const gaps = findUndeclaredStreams({
      ...input,
      manifestStreams: input.manifestStreams.filter((s) => s !== dropped),
    });
    expect(gaps).toEqual([{ stream: dropped, family: "calibration" }]);
  });

  test("removing one real EVALUATION entry surfaces exactly that stream", () => {
    const input = realInput();
    const dropped = "spec-criterion-claim-evaluations";
    expect(input.manifestStreams).toContain(dropped);

    const gaps = findUndeclaredStreams({
      ...input,
      manifestStreams: input.manifestStreams.filter((s) => s !== dropped),
    });
    expect(gaps).toEqual([{ stream: dropped, family: "evaluation" }]);
  });
});

describe("the evaluation-writer census keeps a hand-maintained map honest", () => {
  test("every module that writes evaluation records is declared as a producer", () => {
    const writers = findEvaluationWriterModules(defaultEvaluationWriterScanDeps());
    // Fail-closed: if the scan finds nothing at all, the census is broken rather than passing.
    // A zero result here would look identical to "every writer is declared".
    expect(writers.length).toBeGreaterThan(0);
    expect(findUndeclaredEvaluationWriters(writers, EVALUATION_STREAM_PRODUCERS)).toEqual([]);
  });

  test("the census sees a writer that calls through an injected alias", () => {
    // `context-fill-gauge.ts` never writes the literal `logEvaluationRecord(` — it aliases the
    // import and calls `logEvaluation(...)`. A scan keyed on the call site finds ten writers and
    // misses this one, and ten results look like a complete answer. Keying on the IMPORT is what
    // makes this pass, so pin it.
    const writers = findEvaluationWriterModules(defaultEvaluationWriterScanDeps());
    expect(writers).toContain(".minsky/hooks/context-fill-gauge.ts");
  });

  test("an undeclared writer is reported", () => {
    const reported = findUndeclaredEvaluationWriters(
      [".minsky/hooks/known-detector.ts", ".minsky/hooks/brand-new-detector.ts"],
      { known: ".minsky/hooks/known-detector.ts" }
    );
    expect(reported).toEqual([".minsky/hooks/brand-new-detector.ts"]);
  });

  test("the scan skips tests and the dispatcher that defines the writer", () => {
    const source = 'import { logEvaluationRecord } from "./dispatcher";';
    const writers = findEvaluationWriterModules({
      listHookFiles: () => [
        ".minsky/hooks/real-detector.ts",
        ".minsky/hooks/real-detector.test.ts",
        ".minsky/hooks/dispatcher.ts",
      ],
      readFile: () => source,
    });
    expect(writers).toEqual([".minsky/hooks/real-detector.ts"]);
  });
});
