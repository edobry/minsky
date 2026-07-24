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
  clearResolvedAskIds,
  selectAckablePaths,
  runSweep,
  computeReviewDueLogs,
  calibrationRecordToFireLogEntry,
  calibrationLogAsFireLogEntries,
  readAllCalibrationLogsAsFireLogEntries,
  findInvalidLiveSinceDates,
  FIRES_THRESHOLD,
  DIVERSITY_THRESHOLD,
  STALE_DAYS_MS,
  NEVER_REVIEWED_DAYS,
  CALIBRATION_LOG_REGISTRY,
  UNKNOWN_SILENT_STRETCH_SESSION_LABEL,
  type CalibrationLogEntry,
  type CalibrationLogResult,
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
const SILENT_STRETCH_KIND = "silent-stretch";
const BUILD_CLAIM_INJECTION_KIND = "build-claim-injection";
const KNOWLEDGE_ACQUISITION_KIND = "knowledge-acquisition";
const ENGINEERING_WRITING_SKILL_NAME = "engineering-writing";
const CONSTRUCTED_IDENTIFIER_BATCH_KIND = "constructed-identifier-batch";
const TEST_ASK_ID = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";
const RETRO_PATH = ".minsky/retrospective-trigger-calibration.jsonl";
const CAUSAL_GUARD_NAME = "causal-premise-detector";
const RETRO_GUARD_NAME = "retrospective-trigger-scanner";
const RECORD_PARSE_FAIL = "record failed to parse";
const POLICY_COVERAGE_MISSING = "policy-coverage entry missing";

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

function makeSilentStretchRecord(
  sessionId = "test-session",
  gapMinutes = 12.5,
  toolCallCount = 15
): string {
  return JSON.stringify({
    timestamp: "2026-07-16T00:00:00Z",
    session_id: sessionId,
    gapMinutes,
    toolCallCount,
    hadTextInTurn: false,
  });
}

function buildLines(count: number, makeLine: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeLine(i)).join("\n");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("CALIBRATION_LOG_REGISTRY", () => {
  test("has twelve entries (mt#2619 adds three; mt#2866 adds silent-stretch; mt#2870 adds wall-of-text; mt#2923 adds build-claim-injection; mt#2708 adds knowledge-acquisition; mt#3125 adds constructed-identifier-batch; mt#3179 adds untaken-action)", () => {
    expect(CALIBRATION_LOG_REGISTRY).toHaveLength(12);
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

  test("seventh entry is silent-stretch (mt#2866)", () => {
    expect(CALIBRATION_LOG_REGISTRY[6]?.kind).toBe(SILENT_STRETCH_KIND);
    expect(CALIBRATION_LOG_REGISTRY[6]?.name).toBe(SILENT_STRETCH_KIND);
    expect(CALIBRATION_LOG_REGISTRY[6]?.path).toBe(".minsky/silent-stretch-calibration.jsonl");
  });

  test("eighth entry is wall-of-text (mt#2870)", () => {
    expect(CALIBRATION_LOG_REGISTRY[7]?.kind).toBe("wall-of-text");
    expect(CALIBRATION_LOG_REGISTRY[7]?.name).toBe("wall-of-text");
    expect(CALIBRATION_LOG_REGISTRY[7]?.path).toBe(".minsky/wall-of-text-calibration.jsonl");
  });

  test("ninth entry is build-claim-injection (mt#2923) with a reviewByDays graduation contract", () => {
    expect(CALIBRATION_LOG_REGISTRY[8]?.kind).toBe(BUILD_CLAIM_INJECTION_KIND);
    expect(CALIBRATION_LOG_REGISTRY[8]?.name).toBe(BUILD_CLAIM_INJECTION_KIND);
    expect(CALIBRATION_LOG_REGISTRY[8]?.path).toBe(
      ".minsky/build-claim-injection-calibration.jsonl"
    );
    expect(CALIBRATION_LOG_REGISTRY[8]?.reviewByDays).toBe(30);
  });

  test("tenth entry is knowledge-acquisition (mt#2708) with a reviewByDays graduation contract + diversity axis", () => {
    expect(CALIBRATION_LOG_REGISTRY[9]?.kind).toBe(KNOWLEDGE_ACQUISITION_KIND);
    expect(CALIBRATION_LOG_REGISTRY[9]?.name).toBe(KNOWLEDGE_ACQUISITION_KIND);
    expect(CALIBRATION_LOG_REGISTRY[9]?.path).toBe(
      ".minsky/knowledge-acquisition-calibration.jsonl"
    );
    expect(CALIBRATION_LOG_REGISTRY[9]?.reviewByDays).toBe(14);
    expect(CALIBRATION_LOG_REGISTRY[9]?.liveSinceDate).toBeDefined();
  });

  test("eleventh entry is constructed-identifier-batch (mt#3125)", () => {
    expect(CALIBRATION_LOG_REGISTRY[10]?.kind).toBe(CONSTRUCTED_IDENTIFIER_BATCH_KIND);
    expect(CALIBRATION_LOG_REGISTRY[10]?.name).toBe(CONSTRUCTED_IDENTIFIER_BATCH_KIND);
    expect(CALIBRATION_LOG_REGISTRY[10]?.path).toBe(
      ".minsky/constructed-identifier-batch-calibration.jsonl"
    );
  });

  test("twelfth entry is untaken-action (mt#3179), reusing the retrospective-trigger kind", () => {
    // The only entry whose `kind` deliberately differs from its `name`: the
    // turn-end-untaken-action-scan guard emits the same {family, phrase}[]
    // record shape as retrospective-trigger, so it reuses that parser kind
    // rather than widening the kind union. `name` is what separates the logs.
    expect(CALIBRATION_LOG_REGISTRY[11]?.kind).toBe(RETRO_KIND);
    expect(CALIBRATION_LOG_REGISTRY[11]?.name).toBe("untaken-action");
    expect(CALIBRATION_LOG_REGISTRY[11]?.path).toBe(".minsky/untaken-action-calibration.jsonl");
  });
});

// ---------------------------------------------------------------------------
// findInvalidLiveSinceDates (PR #2207 R1 review — liveSinceDate bit-rot guard)
// ---------------------------------------------------------------------------

describe("findInvalidLiveSinceDates", () => {
  const NOW_MS = Date.parse("2026-08-01T00:00:00Z");

  test("returns [] when no entry declares liveSinceDate", () => {
    const entries: CalibrationLogEntry[] = [
      { path: CAUSAL_PATH, name: "causal-premise", kind: "causal-premise" },
    ];
    expect(findInvalidLiveSinceDates(entries, NOW_MS)).toEqual([]);
  });

  test("returns [] when liveSinceDate is a valid past date", () => {
    const entries: CalibrationLogEntry[] = [
      {
        path: CAUSAL_PATH,
        name: "causal-premise",
        kind: "causal-premise",
        liveSinceDate: "2026-07-23",
      },
    ];
    expect(findInvalidLiveSinceDates(entries, NOW_MS)).toEqual([]);
  });

  test("flags a liveSinceDate that is in the future relative to nowMs", () => {
    const entries: CalibrationLogEntry[] = [
      {
        path: CAUSAL_PATH,
        name: "causal-premise",
        kind: "causal-premise",
        liveSinceDate: "2099-01-01",
      },
    ];
    const result = findInvalidLiveSinceDates(entries, NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "causal-premise",
      liveSinceDate: "2099-01-01",
      reason: "future",
    });
  });

  test("flags an unparseable liveSinceDate", () => {
    const entries: CalibrationLogEntry[] = [
      {
        path: CAUSAL_PATH,
        name: "causal-premise",
        kind: "causal-premise",
        liveSinceDate: "not-a-date",
      },
    ];
    const result = findInvalidLiveSinceDates(entries, NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe("unparseable");
  });

  test("checks every entry independently, not just the first invalid one", () => {
    const entries: CalibrationLogEntry[] = [
      {
        path: CAUSAL_PATH,
        name: "ok-entry",
        kind: "causal-premise",
        liveSinceDate: "2026-01-01",
      },
      {
        path: RETRO_PATH,
        name: "future-entry",
        kind: RETRO_KIND,
        liveSinceDate: "2099-01-01",
      },
    ];
    const result = findInvalidLiveSinceDates(entries, NOW_MS);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("future-entry");
  });

  test("regression guard: the REAL CALIBRATION_LOG_REGISTRY has no invalid liveSinceDate entries", () => {
    // This is the actual bit-rot guard the PR #2207 R1 review requested: run
    // against the live registry (not a fixture) on every test run, so a
    // future entry with a typo'd or accidentally-future-dated liveSinceDate
    // fails CI immediately rather than silently rotting.
    expect(findInvalidLiveSinceDates(CALIBRATION_LOG_REGISTRY, Date.now())).toEqual([]);
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
    if (!result || !("hadSameTurnVerification" in result)) throw new Error("wrong type");
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

  test("mixed old/new-shape code-mechanism records parse identically (mt#2673 additive backedClaimCount)", () => {
    const oldShape = JSON.stringify({
      timestamp: "2026-06-01T00:00:00Z",
      session_id: "old-session",
      claims: [{ symbol: "executeCommand", predicate: "clamps" }],
      hadSameTurnRead: false,
    });
    const newShape = JSON.stringify({
      timestamp: "2026-07-08T00:00:00Z",
      session_id: "new-session",
      claims: [{ symbol: "session_pr_drive", predicate: "returns" }],
      hadSameTurnRead: true,
      backedClaimCount: 2,
    });
    const oldResult = parseCalibrationRecord(oldShape, CODE_MECHANISM_KIND);
    const newResult = parseCalibrationRecord(newShape, CODE_MECHANISM_KIND);
    expect(oldResult).not.toBeNull();
    expect(newResult).not.toBeNull();
    if (!oldResult || !("claims" in oldResult) || !newResult || !("claims" in newResult)) {
      throw new Error("wrong type");
    }
    expect(oldResult.claims).toHaveLength(1);
    expect(newResult.claims).toEqual([{ symbol: "session_pr_drive", predicate: "returns" }]);
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

  test("parses a valid silent-stretch record (mt#2824, registered mt#2866)", () => {
    const line = makeSilentStretchRecord("conv-a", 11.2, 16);
    const result = parseCalibrationRecord(line, SILENT_STRETCH_KIND);
    expect(result).not.toBeNull();
    if (!result || !("gapMinutes" in result)) throw new Error("wrong type");
    expect(result.gapMinutes).toBe(11.2);
    expect(result.toolCallCount).toBe(16);
    expect(result.session_id).toBe("conv-a");
    expect(result.hadTextInTurn).toBe(false);
  });

  test("returns null for a silent-stretch record missing gapMinutes/toolCallCount", () => {
    const line = JSON.stringify({ timestamp: "2026-01-01", session_id: "x" });
    expect(parseCalibrationRecord(line, SILENT_STRETCH_KIND)).toBeNull();
  });

  test("parses a valid wall-of-text record (mt#2870)", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-17T12:00:00Z",
      session_id: "wall-session",
      wordCount: 912,
      lineCount: 41,
      trigger: "both",
      leadLabelHits: ["gate-letter"],
      deeplinkCount: 0,
      namedRefCount: 7,
    });
    const record = parseCalibrationRecord(line, "wall-of-text");
    expect(record).not.toBeNull();
    if (record && "wordCount" in record) {
      expect(record.wordCount).toBe(912);
      expect(record.trigger).toBe("both");
      expect(record.leadLabelHits).toEqual(["gate-letter"]);
      expect(record.session_id).toBe("wall-session");
    } else {
      throw new Error("expected a WallOfTextRecord");
    }
  });

  test("returns null for a wall-of-text record missing wordCount/trigger", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-17T12:00:00Z",
      session_id: "wall-session",
      lineCount: 41,
    });
    expect(parseCalibrationRecord(line, "wall-of-text")).toBeNull();
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

  test("collects distinct `session_id` (conversation) values from silent-stretch records (mt#2866)", () => {
    const records: CalibrationRecord[] = [
      { timestamp: "t", session_id: "conv-a", gapMinutes: 10, toolCallCount: 15 },
      { timestamp: "t", session_id: "conv-b", gapMinutes: 11, toolCallCount: 16 },
      { timestamp: "t", session_id: "conv-a", gapMinutes: 12, toolCallCount: 17 }, // dup conversation
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
    expect(distinct.has("conv-a")).toBe(true);
    expect(distinct.has("conv-b")).toBe(true);
  });

  test("falls back to UNKNOWN_SILENT_STRETCH_SESSION_LABEL when session_id is missing (mt#2866, PR #2004 R1)", () => {
    // Exported so this label stays byte-for-byte identical to the one
    // src/adapters/shared/commands/calibration.ts's formatResult uses for the
    // same fallback case — a PR #2004 R1 non-blocking finding was that the two
    // surfaces had silently drifted ("unknown-session" vs "unknown").
    const records: CalibrationRecord[] = [
      { timestamp: "t", gapMinutes: 10, toolCallCount: 15 }, // no session_id
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(1);
    expect(distinct.has(UNKNOWN_SILENT_STRETCH_SESSION_LABEL)).toBe(true);
  });

  test("collects distinct `loadedSkills` values from knowledge-acquisition records (mt#2708)", () => {
    // Declared diversity axis per the mt#2708 spec's Graduation contract —
    // distinct loaded-skill names, NOT matched phrases or session/conversation
    // ids, so a single skill firing across many sessions still surfaces as
    // low-diversity while a genuinely varied set of skills does not.
    const records: CalibrationRecord[] = [
      {
        timestamp: "t",
        session_id: "conv-a",
        detectionRung: "1+2-lite",
        researchTools: ["WebSearch"],
        loadedSkills: [ENGINEERING_WRITING_SKILL_NAME],
        hadPropagation: false,
      },
      {
        timestamp: "t",
        session_id: "conv-b",
        detectionRung: "1+2-lite",
        researchTools: ["WebFetch"],
        loadedSkills: ["cockpit-design"],
        hadPropagation: false,
      },
      {
        timestamp: "t",
        session_id: "conv-c",
        detectionRung: "1+2-lite",
        researchTools: ["WebSearch"],
        loadedSkills: [ENGINEERING_WRITING_SKILL_NAME], // dup skill, different conversation
        hadPropagation: false,
      },
    ];
    const distinct = extractDistinctPhrases(records);
    expect(distinct.size).toBe(2);
    expect(distinct.has(ENGINEERING_WRITING_SKILL_NAME)).toBe(true);
    expect(distinct.has("cockpit-design")).toBe(true);
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
  path: RETRO_PATH,
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

describe("computeLogResult — silent-stretch kind (mt#2824, registered mt#2866)", () => {
  const SILENT_STRETCH_ENTRY: CalibrationLogEntry = {
    path: ".minsky/silent-stretch-calibration.jsonl",
    name: SILENT_STRETCH_KIND,
    kind: SILENT_STRETCH_KIND,
  };

  test("mt#2866 acceptance test: 12 fires across 4 distinct conversations crosses pastThreshold", () => {
    const conversations = ["conv-a", "conv-b", "conv-c", "conv-d"];
    const count = 12;
    const content = buildLines(count, (i) =>
      makeSilentStretchRecord(conversations[i % conversations.length])
    );
    const result = computeLogResult(SILENT_STRETCH_ENTRY, content, true, undefined);
    expect(result.totalFires).toBe(12);
    expect(result.firesSinceLastReview).toBe(12);
    expect(result.distinctPhrases).toBe(4);
    expect(result.atCountThreshold).toBe(true);
    expect(result.lowDiversity).toBe(false);
    expect(result.pastThreshold).toBe(true);
  });

  test("diversity is measured over distinct conversations, not fire count", () => {
    const count = FIRES_THRESHOLD;
    const content = buildLines(count, () => makeSilentStretchRecord("only-one-conversation"));
    const result = computeLogResult(SILENT_STRETCH_ENTRY, content, true, undefined);
    expect(result.atCountThreshold).toBe(true);
    expect(result.distinctPhrases).toBe(1);
    expect(result.lowDiversity).toBe(true);
    expect(result.pastThreshold).toBe(false);
  });

  test("not past threshold below the fire-count bar even with diverse conversations", () => {
    const count = FIRES_THRESHOLD - 1;
    const conversations = ["conv-a", "conv-b", "conv-c", "conv-d"];
    const content = buildLines(count, (i) =>
      makeSilentStretchRecord(conversations[i % conversations.length])
    );
    const result = computeLogResult(SILENT_STRETCH_ENTRY, content, true, undefined);
    expect(result.atCountThreshold).toBe(false);
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

  test("forwards openAskId from the watermark (mt#2659)", () => {
    const watermark: LogWatermark = {
      lastReviewedCount: 0,
      lastReviewedAt: "2026-06-01T00:00:00Z",
      openAskId: TEST_ASK_ID,
    };
    const result = computeLogResult(CAUSAL_ENTRY, "", false, watermark);
    expect(result.openAskId).toBe(TEST_ASK_ID);
  });

  test("openAskId is undefined when the watermark has none", () => {
    const watermark: LogWatermark = {
      lastReviewedCount: 0,
      lastReviewedAt: "2026-06-01T00:00:00Z",
    };
    const result = computeLogResult(CAUSAL_ENTRY, "", false, watermark);
    expect(result.openAskId).toBeUndefined();
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

  test("records openAskId on advanced watermarks when askId is provided (mt#2659)", () => {
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
    const updated = advanceWatermarks(
      current,
      results,
      ackedPaths,
      "2026-06-10T00:00:00Z",
      TEST_ASK_ID
    );
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBe(TEST_ASK_ID);
  });

  test("omits openAskId on advanced watermarks when askId is not provided and none existed before", () => {
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
    const updated = advanceWatermarks(current, results, ackedPaths, "2026-06-10T00:00:00Z");
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBeUndefined();
  });

  test("PRESERVES a pre-existing openAskId when askId is not provided (mt#2659 review fix, BLOCKING 1)", () => {
    // A prior pass recorded an open disposition ask on this watermark. A later
    // --ack call (e.g. re-acking a DIFFERENT log in the same sweep) must not
    // silently drop that reference — only clearResolvedAskIds() may clear it.
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 5,
        lastReviewedAt: "2026-06-01T00:00:00Z",
        openAskId: TEST_ASK_ID,
      },
    };
    const results = [
      computeLogResult(
        CAUSAL_ENTRY,
        buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
        true,
        current[CAUSAL_ENTRY.path]
      ),
    ];
    const ackedPaths = new Set([CAUSAL_ENTRY.path]);
    const updated = advanceWatermarks(current, results, ackedPaths, "2026-06-10T00:00:00Z");
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBe(TEST_ASK_ID);
    // lastReviewedCount/At still advance normally.
    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedCount).toBe(FIRES_THRESHOLD);
    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedAt).toBe("2026-06-10T00:00:00Z");
  });

  test("OVERRIDES a pre-existing openAskId when a new askId is explicitly provided", () => {
    const otherAskId = "11111111-1111-1111-1111-111111111111";
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 5,
        lastReviewedAt: "2026-06-01T00:00:00Z",
        openAskId: otherAskId,
      },
    };
    const results = [
      computeLogResult(
        CAUSAL_ENTRY,
        buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
        true,
        current[CAUSAL_ENTRY.path]
      ),
    ];
    const ackedPaths = new Set([CAUSAL_ENTRY.path]);
    const updated = advanceWatermarks(
      current,
      results,
      ackedPaths,
      "2026-06-10T00:00:00Z",
      TEST_ASK_ID
    );
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBe(TEST_ASK_ID);
  });
});

// ---------------------------------------------------------------------------
// clearResolvedAskIds
// ---------------------------------------------------------------------------

describe("clearResolvedAskIds", () => {
  const OTHER_ASK_ID = "11111111-1111-1111-1111-111111111111";

  test("clears openAskId for watermarks matching a resolved ask id", () => {
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 10,
        lastReviewedAt: "2026-06-10T00:00:00Z",
        openAskId: TEST_ASK_ID,
      },
    };
    const updated = clearResolvedAskIds(current, new Set([TEST_ASK_ID]));
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBeUndefined();
    // Other fields untouched.
    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedCount).toBe(10);
    expect(updated[CAUSAL_ENTRY.path]?.lastReviewedAt).toBe("2026-06-10T00:00:00Z");
  });

  test("leaves watermarks with a different openAskId untouched", () => {
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 10,
        lastReviewedAt: "2026-06-10T00:00:00Z",
        openAskId: OTHER_ASK_ID,
      },
    };
    const updated = clearResolvedAskIds(current, new Set([TEST_ASK_ID]));
    expect(updated[CAUSAL_ENTRY.path]?.openAskId).toBe(OTHER_ASK_ID);
  });

  test("is a no-op (same reference) when resolvedAskIds is empty", () => {
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 10,
        lastReviewedAt: "2026-06-10T00:00:00Z",
        openAskId: TEST_ASK_ID,
      },
    };
    const updated = clearResolvedAskIds(current, new Set());
    expect(updated).toBe(current);
  });

  test("does not mutate the input store", () => {
    const current: WatermarkStore = {
      [CAUSAL_ENTRY.path]: {
        lastReviewedCount: 10,
        lastReviewedAt: "2026-06-10T00:00:00Z",
        openAskId: TEST_ASK_ID,
      },
    };
    clearResolvedAskIds(current, new Set([TEST_ASK_ID]));
    expect(current[CAUSAL_ENTRY.path]?.openAskId).toBe(TEST_ASK_ID);
  });
});

// ---------------------------------------------------------------------------
// selectAckablePaths (mt#2659 review fix, BLOCKING 2)
// ---------------------------------------------------------------------------

describe("selectAckablePaths", () => {
  test("BLOCKING scenario: ack without askId SKIPS a past-threshold log that already has an open ask", () => {
    const openResult = computeLogResult(
      CAUSAL_ENTRY,
      buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
      true,
      { lastReviewedCount: 0, lastReviewedAt: "2026-06-01T00:00:00Z", openAskId: TEST_ASK_ID }
    );
    const { ackablePaths, skippedOpenAskPaths } = selectAckablePaths([openResult]);
    expect(ackablePaths.has(CAUSAL_ENTRY.path)).toBe(false);
    expect(skippedOpenAskPaths).toEqual([CAUSAL_ENTRY.path]);
  });

  test("BLOCKING scenario: ack without askId still advances a past-threshold log with NO open ask", () => {
    const cleanResult = computeLogResult(
      RETRO_ENTRY,
      buildLines(FIRES_THRESHOLD, (i) => makeRetroRecord([{ family: "R1", phrase: `p${i}` }])),
      true,
      undefined
    );
    const { ackablePaths, skippedOpenAskPaths } = selectAckablePaths([cleanResult]);
    expect(ackablePaths.has(RETRO_ENTRY.path)).toBe(true);
    expect(skippedOpenAskPaths).toHaveLength(0);
  });

  test("a mixed batch skips only the open-ask log, advances the rest", () => {
    const openResult = computeLogResult(
      CAUSAL_ENTRY,
      buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
      true,
      { lastReviewedCount: 0, lastReviewedAt: "2026-06-01T00:00:00Z", openAskId: TEST_ASK_ID }
    );
    const cleanResult = computeLogResult(
      RETRO_ENTRY,
      buildLines(FIRES_THRESHOLD, (i) => makeRetroRecord([{ family: "R1", phrase: `p${i}` }])),
      true,
      undefined
    );
    const { ackablePaths, skippedOpenAskPaths } = selectAckablePaths([openResult, cleanResult]);
    expect(ackablePaths.has(CAUSAL_ENTRY.path)).toBe(false);
    expect(ackablePaths.has(RETRO_ENTRY.path)).toBe(true);
    expect(skippedOpenAskPaths).toEqual([CAUSAL_ENTRY.path]);
  });

  test("providing askId ackables EVERY past-threshold log, including ones with a pre-existing openAskId", () => {
    const openResult = computeLogResult(
      CAUSAL_ENTRY,
      buildLines(FIRES_THRESHOLD, (i) => makeCausalRecord([`p${i}`])),
      true,
      { lastReviewedCount: 0, lastReviewedAt: "2026-06-01T00:00:00Z", openAskId: TEST_ASK_ID }
    );
    const { ackablePaths, skippedOpenAskPaths } = selectAckablePaths([openResult], TEST_ASK_ID);
    expect(ackablePaths.has(CAUSAL_ENTRY.path)).toBe(true);
    expect(skippedOpenAskPaths).toHaveLength(0);
  });

  test("returns empty ackablePaths/skippedOpenAskPaths for an empty input", () => {
    const { ackablePaths, skippedOpenAskPaths } = selectAckablePaths([]);
    expect(ackablePaths.size).toBe(0);
    expect(skippedOpenAskPaths).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Fire-log schema adapter (mt#2889)
// ---------------------------------------------------------------------------

function makePolicyCoverageRecord(outcome: string): string {
  return JSON.stringify({
    timestamp: "2026-06-01T12:00:00Z",
    sessionId: "test-session",
    toolName: "Edit",
    reason: "new-file",
    outcome,
  });
}

describe("calibrationRecordToFireLogEntry / decision mapping", () => {
  test("causal-premise record maps to guardName=causal-premise-detector, decision=warn", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "causal-premise");
    if (!entry) throw new Error("causal-premise entry missing");
    const record = parseCalibrationRecord(makeCausalRecord(), entry.kind);
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
    expect(fireLogEntry.guardName).toBe(CAUSAL_GUARD_NAME);
    expect(fireLogEntry.event).toBe("Calibration");
    expect(fireLogEntry.decision).toBe("warn");
    expect(fireLogEntry.durationMs).toBe(0);
    expect(fireLogEntry.sessionId).toBe("test-session");
    expect(fireLogEntry.timestamp).toBe("2026-06-01T12:00:00Z");
  });

  test("retrospective-trigger record maps to guardName=retrospective-trigger-scanner, decision=warn", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === RETRO_KIND);
    if (!entry) throw new Error("retrospective-trigger entry missing");
    const record = parseCalibrationRecord(makeRetroRecord(), entry.kind);
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
    expect(fireLogEntry.guardName).toBe("retrospective-trigger-scanner");
    expect(fireLogEntry.decision).toBe("warn");
  });

  test("ask-routing-deferral record maps to guardName=ask-routing-deferral-detector, decision=warn", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === DEFERRAL_KIND);
    if (!entry) throw new Error("ask-routing-deferral entry missing");
    const record = parseCalibrationRecord(makeDeferralRecord(), entry.kind);
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
    expect(fireLogEntry.guardName).toBe("ask-routing-deferral-detector");
    expect(fireLogEntry.decision).toBe("warn");
  });

  test("policy-coverage 'uncovered-blocked' maps to decision=deny", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "policy-coverage");
    if (!entry) throw new Error(POLICY_COVERAGE_MISSING);
    const record = parseCalibrationRecord(
      makePolicyCoverageRecord("uncovered-blocked"),
      entry.kind
    );
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
    expect(fireLogEntry.guardName).toBe("policy-coverage-detector");
    expect(fireLogEntry.decision).toBe("deny");
  });

  test("policy-coverage 'uncovered-logged' maps to decision=warn", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "policy-coverage");
    if (!entry) throw new Error(POLICY_COVERAGE_MISSING);
    const record = parseCalibrationRecord(makePolicyCoverageRecord("uncovered-logged"), entry.kind);
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
    expect(fireLogEntry.decision).toBe("warn");
  });

  test("policy-coverage 'covered' and 'dismissed' map to decision=allow", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "policy-coverage");
    if (!entry) throw new Error(POLICY_COVERAGE_MISSING);
    for (const outcome of ["covered", "dismissed"]) {
      const record = parseCalibrationRecord(makePolicyCoverageRecord(outcome), entry.kind);
      if (!record) throw new Error(RECORD_PARSE_FAIL);
      const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
      expect(fireLogEntry.decision).toBe("allow");
    }
  });

  test("an unmapped calibration name falls back to the entry's own name as guardName", () => {
    const syntheticEntry: CalibrationLogEntry = {
      path: ".minsky/unmapped-calibration.jsonl",
      name: "unmapped-name",
      kind: "causal-premise",
    };
    const record = parseCalibrationRecord(makeCausalRecord(), syntheticEntry.kind);
    if (!record) throw new Error(RECORD_PARSE_FAIL);
    const fireLogEntry = calibrationRecordToFireLogEntry(record, syntheticEntry);
    expect(fireLogEntry.guardName).toBe("unmapped-name");
  });
});

// ---------------------------------------------------------------------------
// Round-trip completeness (mt#2889 PR #2012 R1 — BLOCKING #4)
// ---------------------------------------------------------------------------
//
// Regression test for the exact gap R1 caught: CALIBRATION_LOG_REGISTRY grew
// a 7th entry ("silent-stretch", mt#2866) via this PR's pre-merge rebase onto
// main, landing AFTER CALIBRATION_NAME_TO_GUARD_NAME was first written — the
// hand-maintained map fell out of sync with the registry it must exhaustively
// cover, and the silent fallback-to-entry.name path masked it (no thrown
// error, just a wrong-but-plausible-looking guardName). This test asserts
// EVERY CALIBRATION_LOG_REGISTRY entry — present today AND any added in the
// future — round-trips through calibrationRecordToFireLogEntry to its
// canonical GUARD_REGISTRY name, not a silent fallback. Adding an 8th
// registry entry without a matching case below fails this test immediately
// (the "no fixture for this kind" branch), rather than only surfacing at
// review time on the next PR that happens to touch this file.

/** One minimal, valid raw JSONL line per CalibrationLogEntry.kind, plus the canonical GUARD_REGISTRY name that kind's registry entry must map to. */
const KIND_FIXTURES: Readonly<
  Record<CalibrationLogEntry["kind"], { line: () => string; expectedGuardName: string }>
> = {
  "causal-premise": { line: () => makeCausalRecord(), expectedGuardName: CAUSAL_GUARD_NAME },
  "retrospective-trigger": {
    line: () => makeRetroRecord(),
    expectedGuardName: RETRO_GUARD_NAME,
  },
  "ask-routing-deferral": {
    line: () => makeDeferralRecord(),
    expectedGuardName: "ask-routing-deferral-detector",
  },
  "code-mechanism-assertion": {
    line: () =>
      JSON.stringify({
        timestamp: "2026-06-01T12:00:00Z",
        session_id: "test-session",
        claims: [{ symbol: "executeCommand", predicate: "clamps" }],
        hadSameTurnRead: false,
      }),
    expectedGuardName: "code-mechanism-assertion-detector",
  },
  "pre-narration": {
    // Same matches-shape family as retrospective-trigger (see this file's
    // CalibrationLogEntry.kind doc comment) — reuses makeRetroRecord's shape,
    // parsed under the "pre-narration" kind.
    line: () => makeRetroRecord(),
    expectedGuardName: "pre-narration-detector",
  },
  "policy-coverage": {
    line: () => makePolicyCoverageRecord("covered"),
    expectedGuardName: "policy-coverage-detector",
  },
  "silent-stretch": {
    line: () => makeSilentStretchRecord(),
    expectedGuardName: "silent-stretch-detector",
  },
  "wall-of-text": {
    line: () =>
      JSON.stringify({
        timestamp: "2026-07-17T12:00:00Z",
        session_id: "test-session",
        wordCount: 912,
        lineCount: 41,
        trigger: "both",
      }),
    expectedGuardName: "wall-of-text-detector",
  },
  "build-claim-injection": {
    line: () =>
      JSON.stringify({
        timestamp: "2026-07-21T12:00:00Z",
        session_id: "test-session",
        matchedPhrases: ["you can use it now"],
        deploySurfaceFiles: ["cockpit-tray/src-tauri/src/main.rs"],
      }),
    expectedGuardName: "build-claim-injection-detector",
  },
  [KNOWLEDGE_ACQUISITION_KIND]: {
    line: () =>
      JSON.stringify({
        timestamp: "2026-07-23T12:00:00Z",
        session_id: "test-session",
        detectionRung: "1+2-lite",
        researchTools: ["WebSearch"],
        loadedSkills: [ENGINEERING_WRITING_SKILL_NAME],
        hadPropagation: false,
      }),
    expectedGuardName: "knowledge-acquisition-detector",
  },
  "constructed-identifier-batch": {
    // Same matches-shape family as retrospective-trigger (see this file's
    // CalibrationLogEntry.kind doc comment) — reuses makeRetroRecord's shape,
    // parsed under the "constructed-identifier-batch" kind.
    line: () => makeRetroRecord(),
    expectedGuardName: "constructed-identifier-batch-detector",
  },
};

describe("CALIBRATION_NAME_TO_GUARD_NAME completeness (mt#2889 R1)", () => {
  // mt#3179: `untaken-action` deliberately reuses the retrospective-trigger
  // KIND (byte-identical record shape) while mapping to its OWN guard, so the
  // expected guard name must be resolved per-ENTRY (by name) rather than
  // per-kind. The fixture below still supplies the record LINE by kind — that
  // part is genuinely kind-shaped.
  const NAME_GUARD_OVERRIDES: Readonly<Record<string, string>> = {
    "untaken-action": "turn-end-untaken-action-scan",
  };

  test("every CALIBRATION_LOG_REGISTRY entry maps to its canonical GUARD_REGISTRY name, not a silent fallback to entry.name", () => {
    for (const entry of CALIBRATION_LOG_REGISTRY) {
      const fixture = KIND_FIXTURES[entry.kind];
      if (!fixture) {
        throw new Error(
          `No KIND_FIXTURES entry for CalibrationLogEntry.kind "${entry.kind}" ` +
            `(registry entry name="${entry.name}") — add one so this completeness ` +
            `test actually covers the new kind, per the R1 regression this test guards against.`
        );
      }
      const record = parseCalibrationRecord(fixture.line(), entry.kind);
      if (!record) {
        throw new Error(`Fixture for kind "${entry.kind}" failed to parse — fix KIND_FIXTURES.`);
      }
      const fireLogEntry = calibrationRecordToFireLogEntry(record, entry);
      const expectedGuardName = NAME_GUARD_OVERRIDES[entry.name] ?? fixture.expectedGuardName;
      expect(fireLogEntry.guardName).toBe(expectedGuardName);
      // The exact regression this test prevents: silently falling back to
      // the raw registry name instead of the canonical guard name.
      expect(fireLogEntry.guardName).not.toBe(entry.name);
    }
  });

  test("CALIBRATION_LOG_REGISTRY has exactly 12 entries and every kind has a fixture above", () => {
    expect(CALIBRATION_LOG_REGISTRY).toHaveLength(12);
    for (const entry of CALIBRATION_LOG_REGISTRY) {
      expect(KIND_FIXTURES[entry.kind]).toBeDefined();
    }
  });
});

describe("calibrationLogAsFireLogEntries", () => {
  test("maps every record in a log to a fire-log-schema entry, preserving order and count", () => {
    const entry = CALIBRATION_LOG_REGISTRY.find((e) => e.name === "causal-premise");
    if (!entry) throw new Error("causal-premise entry missing");
    const lines = buildLines(3, (i) => makeCausalRecord([`phrase-${i}`]));
    const records = parseCalibrationLines(lines, entry.kind);
    const fireLogEntries = calibrationLogAsFireLogEntries(records, entry);
    expect(fireLogEntries).toHaveLength(3);
    for (const e of fireLogEntries) {
      expect(e.guardName).toBe(CAUSAL_GUARD_NAME);
      expect(e.decision).toBe("warn");
    }
  });
});

describe("readAllCalibrationLogsAsFireLogEntries", () => {
  test("aggregates records across multiple logs, skipping absent ones — read-only (never touches historical files)", async () => {
    const readContent = async (path: string): Promise<string | null> => {
      if (path === CAUSAL_PATH) return buildLines(2, (i) => makeCausalRecord([`phrase-${i}`]));
      if (path === RETRO_PATH) {
        return buildLines(1, () => makeRetroRecord());
      }
      return null; // every other registered log absent
    };
    const results = await readAllCalibrationLogsAsFireLogEntries(
      CALIBRATION_LOG_REGISTRY,
      readContent
    );
    expect(results).toHaveLength(3);
    const byGuard = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.guardName] = (acc[r.guardName] ?? 0) + 1;
      return acc;
    }, {});
    expect(byGuard[CAUSAL_GUARD_NAME]).toBe(2);
    expect(byGuard[RETRO_GUARD_NAME]).toBe(1);
  });

  test("returns an empty array when every log is absent", async () => {
    const readContent = async (_path: string): Promise<string | null> => null;
    const results = await readAllCalibrationLogsAsFireLogEntries(
      CALIBRATION_LOG_REGISTRY,
      readContent
    );
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeReviewDueLogs — the three-condition review-due matrix (mt#2896)
// ---------------------------------------------------------------------------

describe("computeReviewDueLogs (mt#2896)", () => {
  const NOW = Date.parse("2026-07-21T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  function reviewEntry(
    name: string,
    overrides: Partial<CalibrationLogEntry> = {}
  ): CalibrationLogEntry {
    return {
      path: `.minsky/${name}-calibration.jsonl`,
      name,
      kind: "causal-premise",
      ...overrides,
    };
  }

  function reviewResult(
    entry: CalibrationLogEntry,
    overrides: Partial<CalibrationLogResult> = {}
  ): CalibrationLogResult {
    return {
      entry,
      exists: true,
      totalFires: 0,
      firesSinceLastReview: 0,
      distinctPhrases: 0,
      atCountThreshold: false,
      lowDiversity: false,
      pastThreshold: false,
      newRecords: [],
      watermarkCount: 0,
      ...overrides,
    };
  }

  test("condition 1 — flags a pastThreshold log with reason past-threshold", () => {
    const entry = reviewEntry(DEFERRAL_KIND);
    const results = [
      reviewResult(entry, {
        pastThreshold: true,
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("past-threshold");
  });

  test("condition 2 — flags a reviewed-but-stale log with reason time-stale", () => {
    const entry = reviewEntry(RETRO_KIND);
    const results = [reviewResult(entry, { firesSinceLastReview: 8, totalFires: 20 })];
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + DAY)).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("time-stale");
  });

  test("condition 3 — flags a NEVER-reviewed log whose first fire is >= 30 days old (the causal-premise blind spot)", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 31 * DAY).toISOString(),
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("never-reviewed");
    expect(due[0]?.name).toBe("causal-premise");
    expect(due[0]?.reviewByDays).toBe(NEVER_REVIEWED_DAYS);
  });

  test("condition 3 — does NOT flag a never-reviewed log below the 30-day bar (29 days)", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 29 * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 3 — never-reviewed boundary is inclusive at exactly 30 days", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - NEVER_REVIEWED_DAYS * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(1);
  });

  test("per-entry reviewByDays override tightens the never-reviewed window (7 days)", () => {
    const entry = reviewEntry("learn-capture", { reviewByDays: 7 });
    const at8 = [
      reviewResult(entry, {
        totalFires: 2,
        firesSinceLastReview: 2,
        firstRecordTimestamp: new Date(NOW - 8 * DAY).toISOString(),
      }),
    ];
    const at6 = [
      reviewResult(entry, {
        totalFires: 2,
        firesSinceLastReview: 2,
        firstRecordTimestamp: new Date(NOW - 6 * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(at8, {}, NOW)[0]?.reason).toBe("never-reviewed");
    expect(computeReviewDueLogs(at8, {}, NOW)[0]?.reviewByDays).toBe(7);
    expect(computeReviewDueLogs(at6, {}, NOW)).toHaveLength(0);
  });

  test("never-reviewed leg ignores 0 fires, a missing first timestamp, and a malformed one", () => {
    const entry = reviewEntry("causal-premise");
    const zeroFires = [
      reviewResult(entry, {
        totalFires: 0,
        firesSinceLastReview: 0,
        firstRecordTimestamp: new Date(NOW - 90 * DAY).toISOString(),
      }),
    ];
    const noTs = [reviewResult(entry, { totalFires: 3, firesSinceLastReview: 3 })];
    const badTs = [
      reviewResult(entry, {
        totalFires: 3,
        firesSinceLastReview: 3,
        firstRecordTimestamp: "not-a-date",
      }),
    ];
    expect(computeReviewDueLogs(zeroFires, {}, NOW)).toHaveLength(0);
    expect(computeReviewDueLogs(noTs, {}, NOW)).toHaveLength(0);
    expect(computeReviewDueLogs(badTs, {}, NOW)).toHaveLength(0);
  });

  test("a reviewed log (watermark present, 0 new fires) never takes the never-reviewed leg", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 5,
        firesSinceLastReview: 0,
        firstRecordTimestamp: new Date(NOW - 90 * DAY).toISOString(),
      }),
    ];
    const watermarks: WatermarkStore = {
      [entry.path]: { lastReviewedCount: 5, lastReviewedAt: new Date(NOW - DAY).toISOString() },
    };
    expect(computeReviewDueLogs(results, watermarks, NOW)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // condition 4 — never-fired (mt#3078): a detector with ZERO total fires and
  // no watermark, but its registry entry declares `liveSinceDate` (confirmed
  // alive via a live synthetic test). Closes the residual blind spot: a
  // detector whose real-world trigger is a rare compound condition can sit at
  // true-zero fires forever, which condition 3 (never-reviewed) can't reach
  // because it requires >=1 fire to anchor from.
  // -------------------------------------------------------------------------

  test("condition 4 — flags a zero-fire log whose liveSinceDate is >= the review window old", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 31 * DAY).toISOString(),
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("never-fired");
    expect(due[0]?.reviewByDays).toBe(30);
  });

  test("condition 4 — does NOT flag a zero-fire log whose liveSinceDate is within the review window (29 days)", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 29 * DAY).toISOString(),
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — does NOT flag a zero-fire log with no liveSinceDate declared (silent forever, unchanged pre-mt#3078 behavior)", () => {
    const entry = reviewEntry("some-other-detector");
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — a malformed liveSinceDate is ignored (never flagged, not a throw)", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: "not-a-date",
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — a non-zero-fire log ignores liveSinceDate entirely and takes the never-reviewed leg instead", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 90 * DAY).toISOString(),
    });
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 1 * DAY).toISOString(),
      }),
    ];
    // firstRecordTimestamp is only 1 day old -> not past the 30-day window,
    // so this should NOT be flagged via either leg once totalFires > 0.
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeLogResult — firstRecordTimestamp population (mt#2896)
// ---------------------------------------------------------------------------

describe("computeLogResult — firstRecordTimestamp (mt#2896)", () => {
  const CAUSAL: CalibrationLogEntry = {
    path: ".minsky/causal-premise-calibration.jsonl",
    name: "causal-premise",
    kind: "causal-premise",
  };

  test("surfaces the earliest record's timestamp", () => {
    const content = `${JSON.stringify({
      timestamp: "2026-06-08T22:05:17.665Z",
      matchedPhrases: ["The root cause is"],
      hadSameTurnVerification: false,
    })}\n${JSON.stringify({
      timestamp: "2026-07-01T00:00:00.000Z",
      matchedPhrases: ["because"],
      hadSameTurnVerification: true,
    })}\n`;
    const result = computeLogResult(CAUSAL, content, true, undefined);
    expect(result.firstRecordTimestamp).toBe("2026-06-08T22:05:17.665Z");
  });

  test("is undefined for an absent/empty log", () => {
    const result = computeLogResult(CAUSAL, "", false, undefined);
    expect(result.firstRecordTimestamp).toBeUndefined();
  });
});
