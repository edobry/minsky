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
const DEFERRAL_KIND = "ask-routing-deferral";
const DEFERRAL_CLASS = "principal-reserved";
const CODE_MECHANISM_KIND = "code-mechanism-assertion";

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

function makeDeferralRecord(
  matches: Array<{ class: string; phrase: string }> = [
    { class: DEFERRAL_CLASS, phrase: "needs your call" },
  ]
): string {
  return JSON.stringify({
    timestamp: "2026-06-16T00:00:00Z",
    session_id: "test-session",
    injection_enabled: false,
    matches,
  });
}

function buildLines(count: number, makeLine: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeLine(i)).join("\n");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("CALIBRATION_LOG_REGISTRY", () => {
  test("has six entries (mt#2619 — cadence closeout adds three more logs)", () => {
    expect(CALIBRATION_LOG_REGISTRY).toHaveLength(6);
  });

  test("first entry is causal-premise", () => {
    expect(CALIBRATION_LOG_REGISTRY[0]?.kind).toBe("causal-premise");
    expect(CALIBRATION_LOG_REGISTRY[0]?.name).toBe("causal-premise");
  });

  test("second entry is retrospective-trigger", () => {
    expect(CALIBRATION_LOG_REGISTRY[1]?.kind).toBe(RETRO_KIND);
    expect(CALIBRATION_LOG_REGISTRY[1]?.name).toBe(RETRO_KIND);
  });

  test("third entry is ask-routing-deferral (mt#2498)", () => {
    expect(CALIBRATION_LOG_REGISTRY[2]?.kind).toBe(DEFERRAL_KIND);
    expect(CALIBRATION_LOG_REGISTRY[2]?.name).toBe(DEFERRAL_KIND);
    expect(CALIBRATION_LOG_REGISTRY[2]?.path).toBe(
      ".minsky/ask-routing-deferral-calibration.jsonl"
    );
  });

  test("fourth entry is code-mechanism-assertion (mt#2619)", () => {
    expect(CALIBRATION_LOG_REGISTRY[3]?.kind).toBe(CODE_MECHANISM_KIND);
    expect(CALIBRATION_LOG_REGISTRY[3]?.name).toBe(CODE_MECHANISM_KIND);
    expect(CALIBRATION_LOG_REGISTRY[3]?.path).toBe(
      ".minsky/code-mechanism-assertion-calibration.jsonl"
    );
  });

  test("fifth entry is pre-narration (mt#2619)", () => {
    expect(CALIBRATION_LOG_REGISTRY[4]?.kind).toBe("pre-narration");
    expect(CALIBRATION_LOG_REGISTRY[4]?.name).toBe("pre-narration");
    expect(CALIBRATION_LOG_REGISTRY[4]?.path).toBe(".minsky/pre-narration-calibration.jsonl");
  });

  test("sixth entry is policy-coverage (mt#2619)", () => {
    expect(CALIBRATION_LOG_REGISTRY[5]?.kind).toBe("policy-coverage");
    expect(CALIBRATION_LOG_REGISTRY[5]?.name).toBe("policy-coverage");
    expect(CALIBRATION_LOG_REGISTRY[5]?.path).toBe(".minsky/policy-coverage-calibration.jsonl");
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

  test("parses an ask-routing-deferral record (class-keyed matches, mt#2498)", () => {
    // The hook writes { matches: [{class, phrase}] } — `class` not `family`.
    const line = JSON.stringify({
      timestamp: "2026-06-16T00:00:00Z",
      session_id: "test-session",
      injection_enabled: false,
      matches: [{ class: DEFERRAL_CLASS, phrase: "needs your call" }],
    });
    const result = parseCalibrationRecord(line, DEFERRAL_KIND);
    expect(result).not.toBeNull();
    if (!result || !("matches" in result)) throw new Error("wrong type");
    // `class` is read into the `family` field; `phrase` is preserved.
    expect(result.matches).toEqual([{ family: DEFERRAL_CLASS, phrase: "needs your call" }]);
  });

  test("parses a pre-narration record (category-keyed matches, mt#2619)", () => {
    // The hook writes { matches: [{category, phrase, expectedTool, hadMatchingTool}] }.
    const line = JSON.stringify({
      timestamp: "2026-06-01T00:00:00Z",
      session_id: "test-session",
      matches: [
        {
          category: "merged",
          phrase: "PR #123 merged",
          expectedTool: "session_pr_merge",
          hadMatchingTool: false,
        },
      ],
    });
    const result = parseCalibrationRecord(line, "pre-narration");
    expect(result).not.toBeNull();
    if (!result || !("matches" in result)) throw new Error("wrong type");
    expect(result.matches).toEqual([{ family: "merged", phrase: "PR #123 merged" }]);
  });

  test("parses a code-mechanism-assertion record (mt#2486, registered mt#2619)", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-01T00:00:00Z",
      session_id: "test-session",
      claims: [{ symbol: "executeCommand", predicate: "clamps" }],
      hadSameTurnRead: false,
    });
    const result = parseCalibrationRecord(line, CODE_MECHANISM_KIND);
    expect(result).not.toBeNull();
    if (!result || !("claims" in result)) throw new Error("wrong type");
    expect(result.claims).toEqual([{ symbol: "executeCommand", predicate: "clamps" }]);
    expect(result.hadSameTurnRead).toBe(false);
  });

  test("parses a policy-coverage record (mt#1575, registered mt#2619)", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-01T00:00:00Z",
      sessionId: "test-session",
      toolName: "Edit",
      reason: "new-file",
      filePath: "/tmp/foo.ts",
      outcome: "covered",
      evidence: [{ policySource: "CLAUDE.md (project)", matchedCategory: "module" }],
    });
    const result = parseCalibrationRecord(line, "policy-coverage");
    expect(result).not.toBeNull();
    if (!result || !("reason" in result)) throw new Error("wrong type");
    expect(result.reason).toBe("new-file");
    expect(result.outcome).toBe("covered");
    expect(result.session_id).toBe("test-session");
  });

  test("returns null for a policy-coverage record missing reason/outcome", () => {
    const line = JSON.stringify({ timestamp: "2026-01-01", sessionId: "x" });
    expect(parseCalibrationRecord(line, "policy-coverage")).toBeNull();
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

  test("collects distinct symbol::predicate pairs from code-mechanism-assertion records", () => {
    const records: CalibrationRecord[] = [
      {
        timestamp: "t",
        claims: [
          { symbol: "executeCommand", predicate: "clamps" },
          { symbol: "maxBuffer", predicate: "defaults to" },
        ],
        hadSameTurnRead: false,
      },
      {
        timestamp: "t",
        claims: [{ symbol: "executeCommand", predicate: "clamps" }], // dup
        hadSameTurnRead: true,
      },
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
    expect(distinct.has("executeCommand::clamps")).toBe(true);
    expect(distinct.has("maxBuffer::defaults to")).toBe(true);
  });

  test("collects distinct `reason` values from policy-coverage records", () => {
    const records: CalibrationRecord[] = [
      { timestamp: "t", reason: "new-file", outcome: "covered" },
      { timestamp: "t", reason: "new-dependency", outcome: "covered" },
      { timestamp: "t", reason: "new-file", outcome: "covered" }, // dup reason
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
    expect(distinct.has("new-file")).toBe(true);
    expect(distinct.has("new-dependency")).toBe(true);
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

const DEFERRAL_ENTRY: CalibrationLogEntry = {
  path: ".minsky/ask-routing-deferral-calibration.jsonl",
  name: DEFERRAL_KIND,
  kind: DEFERRAL_KIND,
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
    // Diversity-aware: hit the count bar but only 1 distinct phrase → NOT past
    // threshold (keep collecting), lowDiversity flagged, count bar recorded.
    expect(result.atCountThreshold).toBe(true);
    expect(result.pastThreshold).toBe(false);
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

describe("computeLogResult — ask-routing-deferral kind (mt#2498)", () => {
  test("enumerates fires + distinct phrases from class-keyed records against a fixture", () => {
    // Fixture: FIRES_THRESHOLD records, each a distinct {class, phrase} match,
    // so both the count bar and the diversity bar are cleared.
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, (i) =>
      makeDeferralRecord([{ class: DEFERRAL_CLASS, phrase: `deferral phrase ${i}` }])
    );
    const result = computeLogResult(DEFERRAL_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(count);
    expect(result.firesSinceLastReview).toBe(count);
    expect(result.distinctPhrases).toBe(count);
    expect(result.lowDiversity).toBe(false);
    expect(result.pastThreshold).toBe(true);
  });

  test("counts distinct phrases across multi-match records (class-keyed)", () => {
    // Two records, 3 distinct phrases total — phrase dedup works on the
    // class-keyed shape exactly as it does for retrospective-trigger.
    const content = [
      makeDeferralRecord([
        { class: DEFERRAL_CLASS, phrase: "needs your call" },
        { class: "deferral-menu", phrase: "what's your call?" },
      ]),
      makeDeferralRecord([
        { class: DEFERRAL_CLASS, phrase: "needs your call" }, // dup
        { class: "deferral-menu", phrase: "say the word" },
      ]),
    ].join("\n");
    const result = computeLogResult(DEFERRAL_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(2);
    expect(result.distinctPhrases).toBe(3);
  });
});

describe("computeLogResult — policy-coverage kind (mt#1575, registered mt#2619)", () => {
  const POLICY_ENTRY: CalibrationLogEntry = {
    path: ".minsky/policy-coverage-calibration.jsonl",
    name: "policy-coverage",
    kind: "policy-coverage",
  };

  function makePolicyRecord(reason: string, outcome = "covered"): string {
    return JSON.stringify({
      timestamp: "2026-06-01T00:00:00Z",
      sessionId: "test-session",
      toolName: "Edit",
      reason,
      outcome,
    });
  }

  test("diversity is measured over distinct `reason` values, not phrases", () => {
    const reasons = ["new-file", "new-dependency", "new-config-key"];
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, (i) => makePolicyRecord(reasons[i % reasons.length] ?? ""));
    const result = computeLogResult(POLICY_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(count);
    expect(result.distinctPhrases).toBe(3);
    expect(result.pastThreshold).toBe(true);
  });

  test("lowDiversity when every record shares one `reason`", () => {
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, () => makePolicyRecord("new-file"));
    const result = computeLogResult(POLICY_ENTRY, content, true, undefined);
    expect(result.atCountThreshold).toBe(true);
    expect(result.distinctPhrases).toBe(1);
    expect(result.lowDiversity).toBe(true);
    expect(result.pastThreshold).toBe(false);
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
