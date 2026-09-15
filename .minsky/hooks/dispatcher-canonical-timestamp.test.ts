/**
 * mt#5162 SC1 — the D4 sink guarantees ADR-028 §D4's `timestamp` on disk.
 *
 * Seventeen dispatcher-routed writers stamped `ts`; both shared readers had to
 * learn the second spelling after each silently dropped all seventeen logs
 * (mt#4984). `logCalibrationRecord` is the ONE site every `outcome.calibration`
 * record passes through, so promoting a stray `ts` there covers every writer
 * at once, including one written tomorrow against the wrong field name.
 *
 * Split out of `dispatcher.test.ts`, which sits at the 1500-line `max-lines`
 * ceiling — the same reason `dispatcher-output-contract.test.ts` was.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getMinskyStateDir } from "@minsky/shared/paths";
import {
  logCalibrationRecord,
  projectStateKey,
  withCanonicalTimestamp,
  type CalibrationWriteDeps,
} from "./dispatcher";

function makeFakeDeps(): CalibrationWriteDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    existsSync: (p) => dirs.has(p),
    mkdirSync: (p) => {
      dirs.add(p);
    },
    appendFileSync: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
    },
  };
}

const calibrationPath = (repoRoot: string, name: string): string =>
  join(getMinskyStateDir(), "projects", projectStateKey(repoRoot), `${name}-calibration.jsonl`);

describe("logCalibrationRecord — ADR-028 §D4 timestamp promotion (mt#5162)", () => {
  test("a ts-only record is persisted with timestamp beside it, equal, and first", () => {
    const deps = makeFakeDeps();
    const record = { ts: "2026-09-14T23:00:00.000Z", sessionId: "s", outcome: "clean" };
    logCalibrationRecord("nonexistent-search-path", record, { projectDir: "/repo", deps });

    const line = (deps.files.get(calibrationPath("/repo", "nonexistent-search-path")) ?? "").trim();
    const persisted = JSON.parse(line) as Record<string, unknown>;
    expect(persisted["timestamp"]).toBe("2026-09-14T23:00:00.000Z");
    expect(persisted["ts"]).toBe("2026-09-14T23:00:00.000Z");
    expect(Object.keys(persisted)[0]).toBe("timestamp");
    // The caller's object is untouched — the promotion happens on the persisted copy only.
    expect(Object.keys(record)).toEqual(["ts", "sessionId", "outcome"]);
  });

  test("a record that already carries timestamp is persisted byte-for-byte", () => {
    const deps = makeFakeDeps();
    const record = { timestamp: "T", sessionId: "s", outcome: "matched" };
    logCalibrationRecord("wall-of-text", record, { projectDir: "/repo", deps });
    const line = (deps.files.get(calibrationPath("/repo", "wall-of-text")) ?? "").trim();
    expect(line).toBe(JSON.stringify(record));
  });

  test("timestamp wins when both spellings are present", () => {
    expect(withCanonicalTimestamp({ timestamp: "A", ts: "B" })).toEqual({
      timestamp: "A",
      ts: "B",
    });
  });

  test("a non-string ts is not promoted — the readers would refuse it under either key", () => {
    expect(withCanonicalTimestamp({ ts: 1_700_000_000_000 })).toEqual({ ts: 1_700_000_000_000 });
    expect(withCanonicalTimestamp({ a: 1 })).toEqual({ a: 1 });
  });

  // PR #3764 R1 (BLOCKING): a non-string `timestamp` beside a string `ts` used to
  // win the spread and leave the persisted record undated under both keys.
  test("a non-string timestamp beside a string ts is replaced by the promotion", () => {
    expect(withCanonicalTimestamp({ timestamp: 123, ts: "A" })).toEqual({
      timestamp: "A",
      ts: "A",
    });
    expect(withCanonicalTimestamp({ timestamp: null, ts: "A", x: 1 })).toEqual({
      timestamp: "A",
      ts: "A",
      x: 1,
    });
  });

  test("the mixed-type case end to end: the persisted line is dated as a reader would date it", () => {
    const deps = makeFakeDeps();
    logCalibrationRecord(
      "truncated-outcome-read",
      { timestamp: 1_700_000_000_000, ts: "2026-09-14T23:00:00.000Z", outcome: "matched" },
      { projectDir: "/repo", deps }
    );
    const line = (deps.files.get(calibrationPath("/repo", "truncated-outcome-read")) ?? "").trim();
    const persisted = JSON.parse(line) as Record<string, unknown>;
    expect(persisted["timestamp"]).toBe("2026-09-14T23:00:00.000Z");
    expect(Object.keys(persisted)[0]).toBe("timestamp");
  });
});
