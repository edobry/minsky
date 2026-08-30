/**
 * Trigger 3 — task-state assertions (mt#4743).
 *
 * The fixtures below are REAL text from the live corpus, not paraphrases. That matters more
 * here than usual: the pattern's whole justification is a measurement over that corpus (174
 * claims, 30.5% wrong), so a test built on invented text would be validating a different
 * pattern than the one the measurement is about.
 *
 * @see mt#4743
 */
import { describe, test, expect } from "bun:test";
import {
  assertedTaskIds,
  computeTaskStateDrift,
  extractTaskStateAssertions,
  renderTaskStateNote,
} from "./task-state-assertion";
import { combineTaskStateDrift, type MemoryStaleness } from "./staleness";

function rec(content: string, description?: string) {
  return description === undefined ? { content } : { content, description };
}

describe("extractTaskStateAssertions (mt#4743)", () => {
  test("the bare parenthetical form — mem#367's actual lineage text", () => {
    // Verbatim from mem#367 `## Structural fix lineage`. This exact sentence is what the
    // originating incident was about: it was corrected in prose while the stale
    // parenthetical stayed in the text above it.
    const content =
      "mt#3855 (TODO) deepens WHAT a citation must prove (R6's provenance requirement)";

    expect(extractTaskStateAssertions(rec(content))).toEqual([
      { taskId: "mt#3855", assertedStatus: "TODO" },
    ]);
  });

  test("a QUALIFIED parenthetical still matches — the closing paren is not required", () => {
    // Both verbatim from mem#367. Anchoring on `)` would miss both, and an annotated status
    // is if anything MORE likely to be stale than a bare one: it is what lineage is made of.
    const content = [
      "mt#4141 (DONE 2026-08-14, PR #2998) — R7's fix.",
      "family structural-fix task mt#2052 (PLANNING, stalled ~83 days as of 2026-08-03)",
    ].join("\n");

    expect(extractTaskStateAssertions(rec(content))).toEqual([
      { taskId: "mt#4141", assertedStatus: "DONE" },
      { taskId: "mt#2052", assertedStatus: "PLANNING" },
    ]);
  });

  test("the description field is scanned too, not just content", () => {
    const assertions = extractTaskStateAssertions(rec("body text", "gated on mt#4742 (TODO)"));
    expect(assertions).toEqual([{ taskId: "mt#4742", assertedStatus: "TODO" }]);
  });

  test("the same task at the same status twice is ONE claim", () => {
    const content = "mt#3855 (TODO) here, and again mt#3855 (TODO) there.";
    expect(extractTaskStateAssertions(rec(content))).toHaveLength(1);
  });

  test("the same task at DIFFERENT statuses is kept as two — a record contradicting itself", () => {
    const content = "earlier: mt#3855 (TODO). later correction: mt#3855 (DONE).";
    expect(extractTaskStateAssertions(rec(content))).toEqual([
      { taskId: "mt#3855", assertedStatus: "TODO" },
      { taskId: "mt#3855", assertedStatus: "DONE" },
    ]);
  });

  test("a bare task mention is NOT an assertion", () => {
    // The negative control for the extractor. "mt#4196 is scoped as MEASUREMENT" is a real
    // task-state assertion in the corpus and is deliberately OUT of v1's scope: it names no
    // status token, so there is nothing to compare against the task record.
    const content =
      "mt#4196 is scoped as MEASUREMENT, not enforcement. See mt#1873 and mt#4742 for detail.";
    expect(extractTaskStateAssertions(rec(content))).toEqual([]);
  });

  test("a parenthetical that is not a status does not match", () => {
    const content = "mt#4448 (which shipped the derivation) and mt#1709 (the annotation)";
    expect(extractTaskStateAssertions(rec(content))).toEqual([]);
  });

  test("assertedTaskIds dedupes across differing statuses for the lookup union", () => {
    const assertions = extractTaskStateAssertions(
      rec("mt#3855 (TODO) ... mt#3855 (DONE) ... mt#4141 (DONE)")
    );
    expect(assertedTaskIds(assertions)).toEqual(["mt#3855", "mt#4141"]);
  });
});

describe("computeTaskStateDrift (mt#4743)", () => {
  const assertions = [
    { taskId: "mt#3855", assertedStatus: "TODO" },
    { taskId: "mt#4141", assertedStatus: "DONE" },
  ];

  test("an assertion the task record contradicts is drift; a matching one is not", () => {
    // mt#3855 really did ship after mem#367 said TODO; mt#4141 really is DONE. Both halves
    // in one call, so this is the discrimination control rather than two one-sided tests.
    const drift = computeTaskStateDrift(
      assertions,
      new Map([
        ["mt#3855", "DONE"],
        ["mt#4141", "DONE"],
      ])
    );

    expect(drift?.drifted).toEqual([
      { taskId: "mt#3855", assertedStatus: "TODO", currentStatus: "DONE", nowTerminal: true },
    ]);
  });

  test("drift to a NON-terminal status is recorded but flagged nowTerminal:false", () => {
    const drift = computeTaskStateDrift(assertions, new Map([["mt#3855", "IN-PROGRESS"]]));
    expect(drift?.drifted[0]).toMatchObject({ currentStatus: "IN-PROGRESS", nowTerminal: false });
  });

  test("every assertion accurate produces NO drift at all", () => {
    const drift = computeTaskStateDrift(
      assertions,
      new Map([
        ["mt#3855", "TODO"],
        ["mt#4141", "DONE"],
      ])
    );
    expect(drift).toBeUndefined();
  });

  test("an unresolvable ref yields no finding rather than a manufactured mismatch", () => {
    // Deliberately different from trigger 1, where an unknown id must stay visible as
    // `unresolved`. There, not knowing means we could not check whether the memory expired.
    // Here it means the record cites a task the graph cannot account for — a different
    // defect, and not this trigger's to report.
    expect(computeTaskStateDrift(assertions, new Map([["mt#3855", undefined]]))).toBeUndefined();
  });
});

describe("combineTaskStateDrift (mt#4743)", () => {
  /** Stands in for whatever trigger 1 or 2 concluded, so the fold's preservation is visible. */
  const PRIOR_NOTE = "TRIGGER ONE NOTE";
  const terminalDrift = {
    drifted: [
      { taskId: "mt#3855", assertedStatus: "TODO", currentStatus: "DONE", nowTerminal: true },
    ],
  };
  const nonTerminalDrift = {
    drifted: [
      {
        taskId: "mt#3855",
        assertedStatus: "TODO",
        currentStatus: "IN-PROGRESS",
        nowTerminal: false,
      },
    ],
  };

  test("terminal drift on a record with no prior verdict renders a note", () => {
    const combined = combineTaskStateDrift(undefined, terminalDrift);
    expect(combined?.outcome).toBe("stale");
    expect(combined?.note).toContain("mt#3855");
    expect(combined?.note).toContain("DONE");
    expect(combined?.taskStateDrift).toEqual(terminalDrift);
  });

  test("NON-terminal drift is recorded but renders nothing and does not promote", () => {
    // The noise guard. Promoting here would flag a third of the corpus's family roots as
    // obsolete on the strength of one aging parenthetical.
    const combined = combineTaskStateDrift(undefined, nonTerminalDrift);
    expect(combined?.outcome).toBe("current");
    expect(combined?.note).toBeUndefined();
    expect(combined?.taskStateDrift).toEqual(nonTerminalDrift);
  });

  test("terminal drift PROMOTES an existing non-stale verdict and appends its note", () => {
    const existing: MemoryStaleness = {
      outcome: "current",
      source: "text",
      completedTasks: [],
      unresolvedTasks: [],
    };

    const combined = combineTaskStateDrift(existing, terminalDrift);

    expect(combined?.outcome).toBe("stale");
    expect(combined?.note).toContain("mt#3855");
  });

  test("an existing note is preserved, not replaced", () => {
    const existing: MemoryStaleness = {
      outcome: "stale",
      source: "associations",
      completedTasks: [{ taskId: "mt#1541", status: "CLOSED" }],
      unresolvedTasks: [],
      note: PRIOR_NOTE,
    };

    const combined = combineTaskStateDrift(existing, terminalDrift);

    expect(combined?.note).toContain(PRIOR_NOTE);
    expect(combined?.note).toContain("mt#3855");
    // Trigger 1's structured finding must survive the fold untouched.
    expect(combined?.completedTasks).toEqual([{ taskId: "mt#1541", status: "CLOSED" }]);
  });

  test("no drift is a pass-through — AT4's guarantee that triggers 1 and 2 are unchanged", () => {
    const existing: MemoryStaleness = {
      outcome: "stale",
      source: "associations",
      completedTasks: [{ taskId: "mt#1541", status: "CLOSED" }],
      unresolvedTasks: [],
      note: PRIOR_NOTE,
    };

    expect(combineTaskStateDrift(existing, undefined)).toBe(existing);
  });
});

describe("renderTaskStateNote (mt#4743)", () => {
  test("states both what the record claims and what is true", () => {
    const note = renderTaskStateNote({
      drifted: [
        { taskId: "mt#3855", assertedStatus: "TODO", currentStatus: "DONE", nowTerminal: true },
      ],
    });

    // The reader's next action depends on which claim moved, so both sides are required.
    expect(note).toContain("says mt#3855 is TODO");
    expect(note).toContain("it is now DONE");
    expect(note).toContain("terminal");
  });
});
