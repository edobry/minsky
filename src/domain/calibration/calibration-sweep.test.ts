/**
 * Unit tests for calibration-sweep.ts pure logic (mt#2483).
 *
 * All tests operate on in-memory data — no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import {
  parseCalibrationRecord,
  parseCalibrationLines,
  extractDistinctPhrases,
  computeLogResult,
  advanceWatermarks,
  runSweep,
  FIRES_THRESHOLD,
  DIVERSITY_THRESHOLD,
  CALIBRATION_LOG_REGISTRY,
  type CalibrationLogEntry,
  type CalibrationRecord,
  type LogWatermark,
  type WatermarkStore,
} from "./calibration-sweep";

// Shared string constants (extracted to satisfy no-magic-string-duplication).
const CAUSAL_PATH = ".minsky/causal-premise-calibration.jsonl";
const RETRO_KIND = "retrospective-trigger";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeCausalRecord(phrases: string[] = ["because of the identity"]): string {
  return JSON.stringify({
    timestamp: "2026-06-01T12:00:00Z",
    session_id: "test-session",
    matchedPhrases: phrases,
    hadSameTurnVerification: false,
  });
}

function makeRetroRecord(
  matches: Array<{ family: string; phrase: string }> = [
    { family: "R1", phrase: "I was wrong about" },
  ]
): string {
  return JSON.stringify({
    timestamp: "2026-06-01T12:00:00Z",
    session_id: "test-session",
    matches,
    transcript_excerpt: "some excerpt",
  });
}

function buildLines(count: number, makeLine: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeLine(i)).join("\n");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("CALIBRATION_LOG_REGISTRY", () => {
  test("has two entries in v1", () => {
    expect(CALIBRATION_LOG_REGISTRY).toHaveLength(2);
  });

  test("first entry is causal-premise", () => {
    expect(CALIBRATION_LOG_REGISTRY[0]?.kind).toBe("causal-premise");
    expect(CALIBRATION_LOG_REGISTRY[0]?.name).toBe("causal-premise");
  });

  test("second entry is retrospective-trigger", () => {
    expect(CALIBRATION_LOG_REGISTRY[1]?.kind).toBe(RETRO_KIND);
    expect(CALIBRATION_LOG_REGISTRY[1]?.name).toBe(RETRO_KIND);
  });
});

// ---------------------------------------------------------------------------
// parseCalibrationRecord
// ---------------------------------------------------------------------------

describe("parseCalibrationRecord", () => {
  test("parses a valid causal-premise record", () => {
    const line = makeCausalRecord(["because of the config"]);
    const result = parseCalibrationRecord(line, "causal-premise");
    expect(result).not.toBeNull();
    if (!result || !("matchedPhrases" in result)) throw new Error("wrong type");
    expect(result.matchedPhrases).toEqual(["because of the config"]);
    expect(result.hadSameTurnVerification).toBe(false);
  });

  test("parses a valid retrospective-trigger record", () => {
    const line = makeRetroRecord([{ family: "R2", phrase: "I didn't think it through" }]);
    const result = parseCalibrationRecord(line, RETRO_KIND);
    expect(result).not.toBeNull();
    if (!result || !("matches" in result)) throw new Error("wrong type");
    expect(result.matches).toEqual([{ family: "R2", phrase: "I didn't think it through" }]);
  });

  test("returns null for invalid JSON", () => {
    expect(parseCalibrationRecord("not json", "causal-premise")).toBeNull();
  });

  test("returns null for causal-premise record missing matchedPhrases", () => {
    const line = JSON.stringify({ timestamp: "2026-01-01", session_id: "x" });
    expect(parseCalibrationRecord(line, "causal-premise")).toBeNull();
  });

  test("handles missing matches in retrospective-trigger (returns empty matches)", () => {
    const line = JSON.stringify({ timestamp: "2026-01-01", session_id: "x" });
    const result = parseCalibrationRecord(line, RETRO_KIND);
    expect(result).not.toBeNull();
    if (!result || !("matches" in result)) throw new Error("wrong type");
    expect(result.matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseCalibrationLines
// ---------------------------------------------------------------------------

describe("parseCalibrationLines", () => {
  test("parses multiple lines", () => {
    const content = [makeCausalRecord(["phrase A"]), makeCausalRecord(["phrase B"])].join("\n");
    const records = parseCalibrationLines(content, "causal-premise");
    expect(records).toHaveLength(2);
  });

  test("skips blank lines", () => {
    const content = [makeCausalRecord(), "", "  ", makeCausalRecord()].join("\n");
    const records = parseCalibrationLines(content, "causal-premise");
    expect(records).toHaveLength(2);
  });

  test("skips invalid JSON lines", () => {
    const content = [makeCausalRecord(), "not json", makeCausalRecord()].join("\n");
    const records = parseCalibrationLines(content, "causal-premise");
    expect(records).toHaveLength(2);
  });

  test("returns empty array for empty string", () => {
    expect(parseCalibrationLines("", "causal-premise")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractDistinctPhrases
// ---------------------------------------------------------------------------

describe("extractDistinctPhrases", () => {
  test("collects distinct phrases from causal-premise records", () => {
    const records: CalibrationRecord[] = [
      {
        timestamp: "t",
        matchedPhrases: ["phrase A", "phrase B"],
        hadSameTurnVerification: false,
      },
      {
        timestamp: "t",
        matchedPhrases: ["phrase A", "phrase C"],
        hadSameTurnVerification: false,
      },
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(3);
    expect(distinct.has("phrase A")).toBe(true);
    expect(distinct.has("phrase B")).toBe(true);
    expect(distinct.has("phrase C")).toBe(true);
  });

  test("collects distinct phrases from retrospective-trigger records", () => {
    const records: CalibrationRecord[] = [
      {
        timestamp: "t",
        matches: [
          { family: "R1", phrase: "I was wrong" },
          { family: "R2", phrase: "I didn't think" },
        ],
      },
      {
        timestamp: "t",
        matches: [{ family: "R1", phrase: "I was wrong" }],
      },
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
  });

  test("returns empty set for empty records", () => {
    expect(extractDistinctPhrases([])).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// computeLogResult
// ---------------------------------------------------------------------------

const CAUSAL_ENTRY: CalibrationLogEntry = {
  path: CAUSAL_PATH,
  name: "causal-premise",
  kind: "causal-premise",
};

const RETRO_ENTRY: CalibrationLogEntry = {
  path: ".minsky/retrospective-trigger-calibration.jsonl",
  name: RETRO_KIND,
  kind: RETRO_KIND,
};

describe("computeLogResult — below threshold", () => {
  test("not past threshold with 0 fires", () => {
    const result = computeLogResult(CAUSAL_ENTRY, "", false, undefined);
    expect(result.exists).toBe(false);
    expect(result.totalFires).toBe(0);
    expect(result.firesSinceLastReview).toBe(0);
    expect(result.pastThreshold).toBe(false);
    expect(result.newRecords).toHaveLength(0);
  });

  test(`not past threshold with ${FIRES_THRESHOLD - 1} fires`, () => {
    const count = FIRES_THRESHOLD - 1;
    const content = buildLines(count, () => makeCausalRecord(["phrase"]));
    const result = computeLogResult(CAUSAL_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(count);
    expect(result.firesSinceLastReview).toBe(count);
    expect(result.pastThreshold).toBe(false);
    expect(result.newRecords).toHaveLength(0);
  });
});

describe("computeLogResult — at or above threshold", () => {
  test(`past threshold with exactly ${FIRES_THRESHOLD} fires`, () => {
    const count = FIRES_THRESHOLD;
    // Use distinct phrases so diversity is met too
    const content = buildLines(count, (i) => makeCausalRecord([`phrase-${i}`]));
    const result = computeLogResult(CAUSAL_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(count);
    expect(result.firesSinceLastReview).toBe(count);
    expect(result.pastThreshold).toBe(true);
    expect(result.newRecords).toHaveLength(count);
    expect(result.distinctPhrases).toBe(count);
    expect(result.lowDiversity).toBe(false);
  });

  test(`past threshold with ${FIRES_THRESHOLD + 5} fires`, () => {
    const count = FIRES_THRESHOLD + 5;
    const content = buildLines(count, (i) => makeCausalRecord([`phrase-${i}`]));
    const result = computeLogResult(CAUSAL_ENTRY, content, true, undefined);
    expect(result.pastThreshold).toBe(true);
    expect(result.totalFires).toBe(count);
  });

  test("lowDiversity flag when few distinct phrases but fires >= threshold", () => {
    // All FIRES_THRESHOLD records have the same phrase
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, () => makeCausalRecord(["same phrase always"]));
    const result = computeLogResult(CAUSAL_ENTRY, content, true, undefined);
    expect(result.pastThreshold).toBe(true);
    expect(result.distinctPhrases).toBe(1);
    expect(result.lowDiversity).toBe(true);
  });

  test("lowDiversity false when diversity >= threshold", () => {
    const count = FIRES_THRESHOLD;
    // DIVERSITY_THRESHOLD distinct phrases distributed across records
    const phrases = Array.from({ length: DIVERSITY_THRESHOLD }, (_, i) => `phrase-${i}`);
    const content = buildLines(count, (i) => makeCausalRecord([phrases[i % phrases.length] ?? ""]));
    const result = computeLogResult(CAUSAL_ENTRY, content, true, undefined);
    expect(result.pastThreshold).toBe(true);
    expect(result.distinctPhrases).toBeGreaterThanOrEqual(DIVERSITY_THRESHOLD);
    expect(result.lowDiversity).toBe(false);
  });
});

describe("computeLogResult — watermark handling", () => {
  test("uses watermark to compute firesSinceLastReview", () => {
    // 15 total, 10 reviewed → 5 new
    const count = 15;
    const reviewedCount = 10;
    const content = buildLines(count, (i) => makeCausalRecord([`phrase-${i}`]));
    const watermark: LogWatermark = {
      lastReviewedCount: reviewedCount,
      lastReviewedAt: "2026-06-01T00:00:00Z",
    };
    const result = computeLogResult(CAUSAL_ENTRY, content, true, watermark);
    expect(result.totalFires).toBe(count);
    expect(result.watermarkCount).toBe(reviewedCount);
    expect(result.firesSinceLastReview).toBe(count - reviewedCount);
    // 5 < FIRES_THRESHOLD → not past threshold
    expect(result.pastThreshold).toBe(false);
  });

  test("after advancing watermark to total, second run has 0 new fires", () => {
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, (i) => makeCausalRecord([`phrase-${i}`]));
    // Simulate first run being acked: watermark = count
    const watermark: LogWatermark = {
      lastReviewedCount: count,
      lastReviewedAt: "2026-06-10T00:00:00Z",
    };
    const result = computeLogResult(CAUSAL_ENTRY, content, true, watermark);
    expect(result.firesSinceLastReview).toBe(0);
    expect(result.pastThreshold).toBe(false);
    expect(result.newRecords).toHaveLength(0);
  });

  test("retrospective-trigger records parsed correctly at threshold", () => {
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, (i) =>
      makeRetroRecord([{ family: "R1", phrase: `phrase-${i}` }])
    );
    const result = computeLogResult(RETRO_ENTRY, content, true, undefined);
    expect(result.pastThreshold).toBe(true);
    expect(result.totalFires).toBe(count);
    expect(result.newRecords).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// advanceWatermarks
// ---------------------------------------------------------------------------

describe("advanceWatermarks", () => {
  test("advances marks for acked paths only", () => {
    const causalPath = CAUSAL_PATH;
    const retroPath = ".minsky/retrospective-trigger-calibration.jsonl";

    const current: WatermarkStore = {};
    const results = [
      {
        ...computeLogResult(
          CAUSAL_ENTRY,
          buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
          true,
          undefined
        ),
      },
      {
        ...computeLogResult(
          RETRO_ENTRY,
          buildLines(FIRES_THRESHOLD, (i) => makeRetroRecord([{ family: "R1", phrase: `p${i}` }])),
          true,
          undefined
        ),
      },
    ];

    const ackedPaths = new Set([causalPath]);
    const updated = advanceWatermarks(current, results, ackedPaths, "2026-06-10T00:00:00Z");

    // Causal advanced
    expect(updated[causalPath]).toBeDefined();
    expect(updated[causalPath]?.lastReviewedCount).toBe(FIRES_THRESHOLD);
    expect(updated[causalPath]?.lastReviewedAt).toBe("2026-06-10T00:00:00Z");

    // Retro NOT advanced
    expect(updated[retroPath]).toBeUndefined();
  });

  test("does not mutate the input store", () => {
    const current: WatermarkStore = {};
    const results = [
      computeLogResult(
        CAUSAL_ENTRY,
        buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
        true,
        undefined
      ),
    ];
    const ackedPaths = new Set([CAUSAL_ENTRY.path]);
    advanceWatermarks(current, results, ackedPaths, "2026-06-10T00:00:00Z");
    expect(current).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// runSweep (integration of pure functions)
// ---------------------------------------------------------------------------

describe("runSweep", () => {
  test("returns one result per registry entry", async () => {
    const entries = CALIBRATION_LOG_REGISTRY;
    const readContent = async (_path: string): Promise<string | null> => null;
    const results = await runSweep(entries, readContent, {});
    expect(results).toHaveLength(entries.length);
  });

  test("marks absent logs as !exists with 0 fires", async () => {
    const readContent = async (_path: string): Promise<string | null> => null;
    const results = await runSweep(CALIBRATION_LOG_REGISTRY, readContent, {});
    for (const r of results) {
      expect(r.exists).toBe(false);
      expect(r.totalFires).toBe(0);
      expect(r.pastThreshold).toBe(false);
    }
  });

  test("marks a log past threshold when fires >= FIRES_THRESHOLD", async () => {
    const count = FIRES_THRESHOLD;
    const readContent = async (path: string): Promise<string | null> => {
      if (path === CAUSAL_PATH) {
        return buildLines(count, (i) => makeCausalRecord([`phrase-${i}`]));
      }
      return null;
    };
    const results = await runSweep(CALIBRATION_LOG_REGISTRY, readContent, {});
    const causalResult = results.find((r) => r.entry.name === "causal-premise");
    if (!causalResult) throw new Error("causal-premise result missing");
    expect(causalResult.pastThreshold).toBe(true);
    expect(causalResult.newRecords).toHaveLength(count);

    const retroResult = results.find((r) => r.entry.name === RETRO_KIND);
    if (!retroResult) throw new Error("retrospective-trigger result missing");
    expect(retroResult.pastThreshold).toBe(false);
  });
});
