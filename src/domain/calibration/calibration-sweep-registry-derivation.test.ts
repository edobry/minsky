/**
 * Tests for `deriveCalibrationLogEntries` / `findUnsweptCalibrationLogs` and
 * the ten mt#3716 kinds' parse coverage — split out of `calibration-sweep.test.ts`
 * to keep that already-large file under the 1500-line lint ceiling.
 *
 * @see mt#3716 — this task
 * @see src/domain/calibration/calibration-sweep.ts — the module under test
 */

import { describe, test, expect } from "bun:test";
import {
  parseCalibrationRecord,
  deriveCalibrationLogEntries,
  findUnsweptCalibrationLogs,
  CALIBRATION_LOG_REGISTRY,
  type CalibrationLogEntry,
} from "./calibration-sweep";

// Shared string constants (satisfies no-magic-string-duplication).
const AGENT_DISPATCH_RECORD_KIND = "agent-dispatch-record";
const EXECUTION_EVIDENCE_AT_COVERAGE_KIND = "execution-evidence-at-coverage";
const CAUSAL_PREMISE_KIND = "causal-premise";

describe("deriveCalibrationLogEntries", () => {
  test("reuses an existing CALIBRATION_LOG_REGISTRY entry unchanged for a declared name it already covers", () => {
    const entries = deriveCalibrationLogEntries([CAUSAL_PREMISE_KIND], CALIBRATION_LOG_REGISTRY);
    const causal = entries.find((e) => e.name === CAUSAL_PREMISE_KIND);
    const original = CALIBRATION_LOG_REGISTRY.find((e) => e.name === CAUSAL_PREMISE_KIND);
    if (!original) throw new Error("causal-premise entry missing from CALIBRATION_LOG_REGISTRY");
    expect(causal).toEqual(original);
  });

  test("synthesizes a generic entry (kind === name, conventional path) for a declared name with no existing entry", () => {
    const entries = deriveCalibrationLogEntries([AGENT_DISPATCH_RECORD_KIND], []);
    expect(entries).toEqual([
      {
        path: `.minsky/${AGENT_DISPATCH_RECORD_KIND}-calibration.jsonl`,
        name: AGENT_DISPATCH_RECORD_KIND,
        kind: AGENT_DISPATCH_RECORD_KIND,
      },
    ]);
  });

  test("a synthesized entry's kind parses via the shared fallback branch, never returning null (SC4)", () => {
    const [entry] = deriveCalibrationLogEntries([AGENT_DISPATCH_RECORD_KIND], []);
    if (!entry) throw new Error("expected one derived entry");
    const record = parseCalibrationRecord(
      JSON.stringify({ timestamp: "2026-08-05T12:00:00Z", sessionId: "s1", outcome: "inserted" }),
      entry.kind
    );
    expect(record).not.toBeNull();
  });

  test("includes a CALIBRATION_LOG_REGISTRY entry not present in declaredNames (union, not intersection)", () => {
    const registryOnly: CalibrationLogEntry = {
      path: ".minsky/registry-only-calibration.jsonl",
      name: "registry-only",
      kind: CAUSAL_PREMISE_KIND,
    };
    const entries = deriveCalibrationLogEntries([], [registryOnly]);
    expect(entries.map((e) => e.name)).toEqual(["registry-only"]);
  });

  test("union of declared + known names, deduplicated and sorted by name", () => {
    const known: CalibrationLogEntry[] = [
      { path: ".minsky/a-calibration.jsonl", name: "a", kind: CAUSAL_PREMISE_KIND },
    ];
    const entries = deriveCalibrationLogEntries(["b", "a"], known);
    expect(entries.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("findUnsweptCalibrationLogs", () => {
  // AT1: a fixture on disk with no declaration anywhere is flagged.
  test("AT1 — a stem declared nowhere is flagged unswept", () => {
    const unswept = findUnsweptCalibrationLogs(
      ["zzz-fake"],
      new Set([CAUSAL_PREMISE_KIND, "retrospective-trigger"])
    );
    expect(unswept).toEqual(["zzz-fake"]);
  });

  test("AT1 (negative control) — removing the fixture clears the finding", () => {
    const unswept = findUnsweptCalibrationLogs([], new Set([CAUSAL_PREMISE_KIND]));
    expect(unswept).toEqual([]);
  });

  // AT2: a stem declared ONLY as a GuardRegistration.calibrationLog (the
  // write-declared-but-unread class this task's amendment describes) — under
  // the OLD "presence in CALIBRATION_LOG_REGISTRY" check this would have
  // been flagged even though it WAS declared; under the new
  // reachability-keyed check it is covered once its name is in the swept set
  // deriveCalibrationLogEntries produces from the declared-name union.
  test("AT2 — a stem declared only via GuardRegistration.calibrationLog is now covered once it is in the swept-names set", () => {
    const sweptNames = new Set(
      deriveCalibrationLogEntries([AGENT_DISPATCH_RECORD_KIND], CALIBRATION_LOG_REGISTRY).map(
        (e) => e.name
      )
    );
    const unswept = findUnsweptCalibrationLogs([AGENT_DISPATCH_RECORD_KIND], sweptNames);
    expect(unswept).toEqual([]);
  });

  test("is keyed on reachability, not membership in CALIBRATION_LOG_REGISTRY directly — a stem covered only by the OLD registry-only check would still be flagged if it were absent from sweptNames", () => {
    // Same scenario as AT2 but WITHOUT deriving from the declared-name union —
    // this is what the pre-mt#3716 check effectively did, and it is the
    // negative control this task's AT2 asks to observe failing before the
    // fix ships.
    const registryOnlyNames = new Set(CALIBRATION_LOG_REGISTRY.map((e) => e.name));
    const unswept = findUnsweptCalibrationLogs([AGENT_DISPATCH_RECORD_KIND], registryOnlyNames);
    expect(unswept).toEqual([AGENT_DISPATCH_RECORD_KIND]);
  });

  test("sorts and dedupes nothing extra when everything is covered", () => {
    expect(findUnsweptCalibrationLogs(["a", "b"], new Set(["a", "b", "c"]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SC4 — every mt#3716 kind parses to a non-null record via the shared
// matches-shape fallback, using a realistic sample raw line per detector's
// actual write shape (see calibration-sweep.ts's kind union doc comment for
// each shape's source).
// ---------------------------------------------------------------------------

const BARE_PROHIBITION_KIND = "bare-prohibition";
const EXECUTION_EVIDENCE_TEST_FIRST_KIND = "execution-evidence-test-first";
const ASK_FORM_LINT_KIND = "ask-form-lint";
const UNWALKED_TASK_KIND = "unwalked-task";
const UNESCALATED_INCIDENT_KIND = "unescalated-incident";
const OPERATOR_INSTRUCTION_TRIGGER_KIND = "operator-instruction-trigger";
const CHAINED_VERIFICATION_COMMANDS_KIND = "chained-verification-commands";
const DUPLICATE_SIGNATURE_SCAN_KIND = "duplicate-signature-scan";

const NEW_KIND_SAMPLES: Record<string, string> = {
  [BARE_PROHIBITION_KIND]: JSON.stringify({
    timestamp: "2026-07-24T12:00:00Z",
    session_id: "s1",
    matches: [{ category: "no-basis", phrase: "must not", excerpt: "you must not do X" }],
  }),
  [EXECUTION_EVIDENCE_AT_COVERAGE_KIND]: JSON.stringify({
    timestamp: "2026-07-23T12:00:00Z",
    session_id: "s1",
    task: "mt#3033",
    prNumber: 2100,
    surface: EXECUTION_EVIDENCE_AT_COVERAGE_KIND,
  }),
  [EXECUTION_EVIDENCE_TEST_FIRST_KIND]: JSON.stringify({
    timestamp: "2026-07-31T12:00:00Z",
    session_id: "s1",
    task: "mt#3244",
    prNumber: 2100,
    decision: "warn",
  }),
  [ASK_FORM_LINT_KIND]: JSON.stringify({
    timestamp: "2026-07-15T12:00:00Z",
    askId: "test-ask-id",
    kind: "capability.escalate",
    matches: [{ class: "missing-force-immediate", phrase: "severity" }],
  }),
  [UNWALKED_TASK_KIND]: JSON.stringify({
    source: "live",
    channel: "stop",
    timestamp: "2026-08-01T12:00:00Z",
    session_id: "s1",
    stop_hook_active: false,
    unwalkedTaskIds: ["mt#3536"],
  }),
  [UNESCALATED_INCIDENT_KIND]: JSON.stringify({
    source: "live",
    channel: "stop",
    timestamp: "2026-08-01T12:00:00Z",
    session_id: "s1",
    stop_hook_active: false,
    incidentFamilies: ["stop-at-handoff"],
  }),
  [OPERATOR_INSTRUCTION_TRIGGER_KIND]: JSON.stringify({
    timestamp: "2026-08-01T12:00:00Z",
    session_id: "s1",
    outcome: "matched",
  }),
  [AGENT_DISPATCH_RECORD_KIND]: JSON.stringify({
    timestamp: "2026-08-05T12:00:00Z",
    sessionId: "s1",
    outcome: "inserted",
  }),
  [CHAINED_VERIFICATION_COMMANDS_KIND]: JSON.stringify({
    timestamp: "2026-08-10T12:00:00Z",
    session_id: "s1",
    outcome: "matched",
  }),
  [DUPLICATE_SIGNATURE_SCAN_KIND]: JSON.stringify({
    timestamp: "2026-08-05T12:00:00Z",
    session_id: "s1",
    outcome: "matched",
    matches: [
      { taskId: "mt#123", status: "TODO", token: "sweeps.test.ts", rule: "path", excerpt: "…" },
    ],
  }),
};

describe("mt#3716 new kinds parse to non-null records (SC4)", () => {
  for (const [kind, sample] of Object.entries(NEW_KIND_SAMPLES)) {
    test(`"${kind}" parses without returning null`, () => {
      const record = parseCalibrationRecord(sample, kind as CalibrationLogEntry["kind"]);
      expect(record).not.toBeNull();
    });
  }

  test("every mt#3716 kind added to the union has a sample above (keeps this file honest as the union grows)", () => {
    const newKinds: CalibrationLogEntry["kind"][] = [
      BARE_PROHIBITION_KIND,
      EXECUTION_EVIDENCE_AT_COVERAGE_KIND,
      EXECUTION_EVIDENCE_TEST_FIRST_KIND,
      ASK_FORM_LINT_KIND,
      UNWALKED_TASK_KIND,
      UNESCALATED_INCIDENT_KIND,
      OPERATOR_INSTRUCTION_TRIGGER_KIND,
      AGENT_DISPATCH_RECORD_KIND,
      CHAINED_VERIFICATION_COMMANDS_KIND,
      DUPLICATE_SIGNATURE_SCAN_KIND,
    ];
    for (const kind of newKinds) {
      expect(NEW_KIND_SAMPLES[kind]).toBeDefined();
    }
  });
});
