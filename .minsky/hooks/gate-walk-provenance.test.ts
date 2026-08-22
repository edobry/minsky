import { describe, expect, test } from "bun:test";
import {
  CALIBRATION_LOG,
  GUARD_NAME,
  NO_DB_CONNECTION,
  OVERRIDE_ENV_VAR,
  buildCalibrationRecord,
  bypassMergePrNumber,
  classifyGateWalk,
  classifyMerge,
  fireLogDecisionFor,
  firstIsoField,
  isOverridden,
  normalizeTaskId,
} from "./gate-walk-provenance";
import type { GateWalkFacts, GateWalkOutcome } from "./gate-walk-provenance";
// The SHARED reader whose verdict decides this detector's coverage receipt.
// Imported here on purpose: asserting the record against the guard's own
// accessors is what let an unreadable record ship (mt#4390).
import { checkCoverageReceipt, readCalibrationEntries } from "./coverage-receipt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// The horizon is the one measured in mt#1880's spec: emission began between
// 2026-06-10 (0 events) and 2026-06-15 (141 events). Fixtures straddle it so
// "before the horizon" and "after the horizon" are the real distinction the
// guard makes, not an arbitrary pair of dates.

const HORIZON = "2026-06-12T00:00:00.000Z";
const AFTER_HORIZON = "2026-08-01T12:00:00.000Z";
const BEFORE_HORIZON = "2026-05-17T23:31:27.571Z";

/** The MCP tool name the guard's primary merge surface reports. */
const MERGE_TOOL_NAME = "mcp__minsky__session_pr_merge";

function facts(overrides: Partial<GateWalkFacts> = {}): GateWalkFacts {
  return { readyEventAt: null, horizonAt: HORIZON, taskCreatedAt: AFTER_HORIZON, ...overrides };
}

// ---------------------------------------------------------------------------
// AT1-AT4 — the four outcomes, each asserted separately
// ---------------------------------------------------------------------------

describe("classifyGateWalk — the four outcomes (mt#1880 AT1-AT4)", () => {
  test("AT1: a task with a → READY event records `gated`", () => {
    const result = classifyGateWalk(facts({ readyEventAt: "2026-08-01T13:00:00.000Z" }));
    expect(result.outcome).toBe("gated");
    expect(result.reason).toContain("2026-08-01T13:00:00.000Z");
  });

  test("AT2: created after the horizon with no → READY event records `ungated`", () => {
    const result = classifyGateWalk(facts({ readyEventAt: null, taskCreatedAt: AFTER_HORIZON }));
    expect(result.outcome).toBe("ungated");
  });

  test("AT3: created BEFORE the emission horizon records `skipped`, not `ungated`", () => {
    // The distinction AT2/AT3 exist to keep apart: both have no event, and only
    // one of them is evidence that nobody gated the task. Collapsing them would
    // make the calibration corpus unable to answer its own question.
    const result = classifyGateWalk(facts({ readyEventAt: null, taskCreatedAt: BEFORE_HORIZON }));
    expect(result.outcome).toBe("skipped");
    expect(result.outcome).not.toBe("ungated");
    expect(result.reason).toContain("predates the emission horizon");
  });

  test("AT4: a non-`task/mt-N` branch records `skipped` (no task id resolved)", () => {
    const result = classifyMerge({ taskId: null, facts: facts() });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("no task id resolved");
  });

  test("AT4 sibling: a resolved task id delegates to the fact-based classifier", () => {
    expect(
      classifyMerge({ taskId: "mt#4320", facts: facts({ readyEventAt: HORIZON }) }).outcome
    ).toBe("gated");
  });
});

// ---------------------------------------------------------------------------
// Absence-is-not-evidence: an unreadable stream must never look like `ungated`
// ---------------------------------------------------------------------------

describe("classifyGateWalk — a failed read is `skipped`, never `ungated`", () => {
  test("an `unavailable` read is skipped even when every other fact looks ungated", () => {
    const result = classifyGateWalk({
      readyEventAt: null,
      horizonAt: null,
      taskCreatedAt: null,
      unavailable: "domain bootstrap failed: Configuration not initialized",
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("Configuration not initialized");
  });

  test("`unavailable` wins even when the facts would otherwise classify `ungated`", () => {
    // The dangerous shape: a read that half-succeeded. Without the explicit
    // field, three nulls from a broken probe are indistinguishable from three
    // nulls from a healthy empty stream (mem#704).
    const result = classifyGateWalk(
      facts({
        readyEventAt: null,
        taskCreatedAt: AFTER_HORIZON,
        unavailable: "read exceeded the 10000ms deadline",
      })
    );
    expect(result.outcome).toBe("skipped");
  });

  test("an empty stream (no horizon at all) is skipped, not ungated", () => {
    const result = classifyGateWalk({
      readyEventAt: null,
      horizonAt: null,
      taskCreatedAt: AFTER_HORIZON,
    });
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("no task.status_changed row at all");
  });

  test("a task with no creation timestamp is skipped, not ungated", () => {
    const result = classifyGateWalk(facts({ taskCreatedAt: null }));
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("no creation timestamp");
  });

  test("an unparseable timestamp is skipped, not ungated", () => {
    const result = classifyGateWalk(facts({ taskCreatedAt: "not-a-date" }));
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("unparseable timestamp");
  });

  test("a found event outranks a horizon question — order is load-bearing", () => {
    // A positive is a positive: a → READY row that predates the computed horizon
    // still proves the gate was walked. Reversing the two checks would let a
    // bookkeeping question override direct evidence.
    const result = classifyGateWalk({
      readyEventAt: BEFORE_HORIZON,
      horizonAt: HORIZON,
      taskCreatedAt: BEFORE_HORIZON,
    });
    expect(result.outcome).toBe("gated");
  });
});

// ---------------------------------------------------------------------------
// AT6 — never denies, asserted over the outcome space rather than read off a flag
// ---------------------------------------------------------------------------

describe("AT6: the guard never returns a deny decision", () => {
  const everyOutcome: GateWalkOutcome[] = ["gated", "ungated", "skipped"];

  test("fireLogDecisionFor returns `allow` for every outcome", () => {
    for (const outcome of everyOutcome) {
      expect(fireLogDecisionFor({ outcome, reason: "fixture" })).toBe("allow");
    }
  });

  test("no fact combination produces anything but `allow`", () => {
    const combinations: GateWalkFacts[] = [
      facts({ readyEventAt: AFTER_HORIZON }),
      facts({ readyEventAt: null }),
      facts({ taskCreatedAt: BEFORE_HORIZON }),
      facts({ horizonAt: null }),
      {
        readyEventAt: null,
        horizonAt: null,
        taskCreatedAt: null,
        unavailable: NO_DB_CONNECTION,
      },
    ];
    for (const f of combinations) {
      expect(fireLogDecisionFor(classifyMerge({ taskId: "mt#1880", facts: f }))).toBe("allow");
    }
    expect(fireLogDecisionFor(classifyMerge({ taskId: null, facts: facts() }))).toBe("allow");
  });

  // The CHANNEL half of AT6 — that no stdout `permissionDecision` is reachable —
  // is carried by the type system rather than by a test, deliberately.
  // `fireLogDecisionFor`'s return TYPE is the literal `"allow"`, and its result
  // is the only value the entry point hands `recordAndExit`, so a deny is not
  // constructible there; and the module does not import `writeOutput` at all, so
  // no stdout payload of any kind is reachable. An earlier cut asserted this by
  // reading and grepping the guard's own source, which `custom/no-real-fs-in-tests`
  // forbids (`lint:strict` runs at `--max-warnings=0` in CI). The static
  // guarantee is the stronger of the two anyway: a grep can be satisfied by text
  // that never runs, whereas the type cannot be satisfied by a deny at all.
});

// ---------------------------------------------------------------------------
// Supporting units
// ---------------------------------------------------------------------------

describe("normalizeTaskId", () => {
  test("qualifies a bare numeric id to the `mt#N` form the events table stores", () => {
    expect(normalizeTaskId("mt1880")).toBe("mt#1880");
    expect(normalizeTaskId("MT#1880")).toBe("mt#1880");
    expect(normalizeTaskId("  mt#1880 ")).toBe("mt#1880");
  });

  test("passes through anything that is not recognisably a task id", () => {
    // It then simply matches no row — which the classifier reports as a fact,
    // not as a crash.
    expect(normalizeTaskId("md#12")).toBe("md#12");
    expect(normalizeTaskId("dependabot/npm/foo")).toBe("dependabot/npm/foo");
  });
});

describe("bypassMergePrNumber — the second merge surface", () => {
  test("matches the gh-api bypass merge its siblings match", () => {
    expect(
      bypassMergePrNumber("gh api PUT /repos/edobry/minsky/pulls/3199/merge -f merge_method=merge")
    ).toBe(3199);
    expect(bypassMergePrNumber("gh api -X PUT /repos/o/r/pulls/42/merge")).toBe(42);
  });

  test("does not match ordinary shell commands", () => {
    // The overwhelming majority of calls on the `Bash` matcher. Each of these
    // must reach the entry point's early exit BEFORE any database work.
    expect(bypassMergePrNumber("bun test")).toBeNull();
    expect(bypassMergePrNumber("gh pr list")).toBeNull();
    expect(bypassMergePrNumber("echo /pulls/3199/mergeable")).toBeNull();
    expect(bypassMergePrNumber("")).toBeNull();
  });

  test("does not match a PR reference that is not a merge call", () => {
    expect(bypassMergePrNumber("gh api /repos/o/r/pulls/3199")).toBeNull();
    expect(bypassMergePrNumber("gh api /repos/o/r/pulls/3199/files")).toBeNull();
  });
});

describe("firstIsoField", () => {
  test("reads a Date column", () => {
    expect(firstIsoField([{ fired: new Date("2026-08-01T12:00:00.000Z") }], "fired")).toBe(
      "2026-08-01T12:00:00.000Z"
    );
  });

  test("reads a stringified timestamp column", () => {
    expect(firstIsoField([{ horizon: "2026-06-12T00:00:00Z" }], "horizon")).toBe(
      "2026-06-12T00:00:00.000Z"
    );
  });

  test("a SQL NULL, an empty result, and a non-array all read as null", () => {
    expect(firstIsoField([{ horizon: null }], "horizon")).toBeNull();
    expect(firstIsoField([], "horizon")).toBeNull();
    expect(firstIsoField(null, "horizon")).toBeNull();
    expect(firstIsoField([{ other: "x" }], "horizon")).toBeNull();
  });

  test("an unparseable string reads as null rather than an Invalid Date", () => {
    expect(firstIsoField([{ horizon: "not-a-date" }], "horizon")).toBeNull();
  });
});

describe("isOverridden", () => {
  test("accepts the documented spellings and nothing else", () => {
    expect(isOverridden({ [OVERRIDE_ENV_VAR]: "1" })).toBe(true);
    expect(isOverridden({ [OVERRIDE_ENV_VAR]: "true" })).toBe(true);
    expect(isOverridden({ [OVERRIDE_ENV_VAR]: "YES" })).toBe(true);
    expect(isOverridden({ [OVERRIDE_ENV_VAR]: "0" })).toBe(false);
    expect(isOverridden({})).toBe(false);
  });
});

describe("buildCalibrationRecord", () => {
  test("carries the outcome, the reason, and every fact the decision rested on", () => {
    const record = buildCalibrationRecord({
      ts: "2026-08-19T18:00:00.000Z",
      sessionId: "sess-1",
      toolName: MERGE_TOOL_NAME,
      taskId: "mt#1880",
      taskResolutionSource: "branch-fallback",
      classification: { outcome: "ungated", reason: "no → READY event" },
      facts: { readyEventAt: null, horizonAt: HORIZON, taskCreatedAt: AFTER_HORIZON },
    });
    expect(record["guard"]).toBe(GUARD_NAME);
    expect(record["outcome"]).toBe("ungated");
    expect(record["taskId"]).toBe("mt#1880");
    expect(record["horizonAt"]).toBe(HORIZON);
    expect(record["taskCreatedAt"]).toBe(AFTER_HORIZON);
    expect(record["taskResolutionSource"]).toBe("branch-fallback");
    // Omitted rather than written as null, so a reader can tell a completed read
    // from a failed one by key presence alone.
    expect(record).not.toHaveProperty("unavailable");
  });

  test("records the failure cause when the read did not complete", () => {
    const record = buildCalibrationRecord({
      ts: "2026-08-19T18:00:00.000Z",
      sessionId: null,
      toolName: null,
      taskId: "mt#1880",
      taskResolutionSource: "tool_input",
      classification: { outcome: "skipped", reason: "unreadable" },
      facts: {
        readyEventAt: null,
        horizonAt: null,
        taskCreatedAt: null,
        unavailable: NO_DB_CONNECTION,
      },
    });
    expect(record["unavailable"]).toBe(NO_DB_CONNECTION);
  });

  test("mt#4390 — the record is READABLE by the shared coverage-receipt reader", () => {
    // The gap this closes: every assertion above checks a field the guard's own
    // code writes and reads, so all of them passed while the record was
    // unreadable by the SHARED reader that decides the detector's verdict. The
    // record was well-formed on its own terms and invisible on everyone else's.
    const record = buildCalibrationRecord({
      ts: "2026-08-19T18:00:00.000Z",
      sessionId: "sess-1",
      toolName: MERGE_TOOL_NAME,
      taskId: "mt#1880",
      taskResolutionSource: "tool_input",
      classification: { outcome: "gated", reason: "a → READY event exists" },
      facts: { readyEventAt: AFTER_HORIZON, horizonAt: HORIZON, taskCreatedAt: AFTER_HORIZON },
    });

    expect(record["timestamp"]).toBe("2026-08-19T18:00:00.000Z");
    // The old key must be GONE, not merely joined by the new one: two spellings
    // of one field is how the next reader picks the wrong one.
    expect(record).not.toHaveProperty("ts");

    // Now the real reader, over the real record shape.
    const now = new Date("2026-08-19T19:00:00.000Z");
    const result = checkCoverageReceipt([record as never], {
      detectorName: GUARD_NAME,
      windowDays: 7,
      now: () => now,
    });
    expect(result.liveFireCount).toBe(1);
    expect(result.state).toBe("covered");

    // Negative control, in-test: strip the timestamp and the SAME reader drops
    // the record. Without this the assertion above could pass against a reader
    // that counted everything regardless of shape.
    const { timestamp: _dropped, ...withoutTimestamp } = record as Record<string, unknown>;
    const blind = checkCoverageReceipt([withoutTimestamp as never], {
      detectorName: GUARD_NAME,
      windowDays: 7,
      now: () => now,
    });
    expect(blind.liveFireCount).toBe(0);
    expect(blind.state).toBe("no-liveness-evidence");
  });

  test("PR #3244 R1 — the FULL production path: writer → JSONL → reader → evaluator", () => {
    // The test above feeds `checkCoverageReceipt` an in-memory object, which
    // skips `readCalibrationEntries` — the shared parser production actually
    // goes through. That parser has its OWN `timestamp` requirement
    // (`isEntryShape`: `typeof r.timestamp === "string"`), so a legacy record is
    // dropped at PARSE, before `Date.parse` is ever reached. Two independent
    // gates, and the earlier one was untested.
    //
    // `readCalibrationEntries` takes injectable fs deps, so this exercises the
    // real parser with no disk I/O — the designed seam rather than a patched
    // collaborator (testing-standards.mdc §Testable Design).
    const jsonlFs = (records: unknown[]) => ({
      existsSync: () => true,
      readFileSync: () => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    });
    const now = new Date("2026-08-19T19:00:00.000Z");
    const evaluate = (records: unknown[]) => {
      const entries = readCalibrationEntries(CALIBRATION_LOG, jsonlFs(records));
      return { entries, result: checkCoverageReceipt(entries, { windowDays: 7, now: () => now }) };
    };

    const record = buildCalibrationRecord({
      ts: "2026-08-19T18:00:00.000Z",
      sessionId: "sess-1",
      toolName: MERGE_TOOL_NAME,
      taskId: "mt#1880",
      taskResolutionSource: "tool_input",
      classification: { outcome: "gated", reason: "a → READY event exists" },
      facts: { readyEventAt: AFTER_HORIZON, horizonAt: HORIZON, taskCreatedAt: AFTER_HORIZON },
    });

    // What the guard writes today survives the round trip and counts.
    const current = evaluate([record]);
    expect(current.entries.length).toBe(1);
    expect(current.result.liveFireCount).toBe(1);
    expect(current.result.state).toBe("covered");

    // Negative control — the pre-mt#4390 shape, reconstructed by renaming the
    // field back. It is dropped by the PARSER, so it never reaches the
    // evaluator at all: `entries` is empty, not merely uncounted.
    const { timestamp, ...rest } = record as Record<string, unknown>;
    const legacy = evaluate([{ ...rest, ts: timestamp }]);
    expect(legacy.entries).toEqual([]);
    expect(legacy.result.liveFireCount).toBe(0);
    expect(legacy.result.state).toBe("no-liveness-evidence");
  });

  test("the calibration log is namespaced to this guard", () => {
    expect(CALIBRATION_LOG).toBe(".minsky/gate-walk-provenance-calibration.jsonl");
  });
});
