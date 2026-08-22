/**
 * Tests for the memory-staleness detection core (mt#1709).
 *
 * The module is a pure functional core with injected lookups, so everything here runs
 * against object literals and a `Map` — no database, no service, no patching.
 */

import { describe, expect, test } from "bun:test";
import {
  computeStaleness,
  extractTrackingTaskRefs,
  renderStalenessNote,
  type MemoryStaleness,
} from "./staleness";

/** The task id every fixture below tracks, and the two clause forms exercised most. */
const TRACKED_TASK = "mt#1700";
const BUDGET_CLAUSE = `Budget: retire when ${TRACKED_TASK} ships.`;
const TRACKING_CLAUSE = `Tracking task: ${TRACKED_TASK}`;
/** A task id deliberately absent from every status map, for the unresolved path. */
const UNKNOWN_TASK = "mt#99999";

/** Convenience: run the whole pipeline the way `search()` does. */
function detect(
  record: { content: string; description?: string; associations?: Record<string, string[]> | null },
  statuses: Record<string, string | undefined>
): MemoryStaleness | undefined {
  const { refs, source } = extractTrackingTaskRefs(record);
  return computeStaleness(refs, source, new Map(Object.entries(statuses)));
}

describe("extractTrackingTaskRefs", () => {
  test("recognizes the canonical budget clause", () => {
    const { refs, source } = extractTrackingTaskRefs({ content: BUDGET_CLAUSE });
    expect(refs).toEqual([TRACKED_TASK]);
    expect(source).toBe("text");
  });

  test("recognizes the documented synonym phrasings", () => {
    // The task's Success Criteria require the budget clause plus at least two synonyms.
    expect(extractTrackingTaskRefs({ content: "Tracking task: mt#1701" }).refs).toEqual([
      "mt#1701",
    ]);
    expect(extractTrackingTaskRefs({ content: "This holds until mt#1702 lands." }).refs).toEqual([
      "mt#1702",
    ]);
    expect(extractTrackingTaskRefs({ content: "Once mt#1703 ships, delete this." }).refs).toEqual([
      "mt#1703",
    ]);
    expect(extractTrackingTaskRefs({ content: "Superseded by mt#1704." }).refs).toEqual([
      "mt#1704",
    ]);
    expect(
      extractTrackingTaskRefs({ content: "Bridge memory until mt#1705 is in place." }).refs
    ).toEqual(["mt#1705"]);
  });

  test("scans the description as well as the content", () => {
    const { refs } = extractTrackingTaskRefs({
      description: "Bridge until mt#1706 ships.",
      content: "Body with no clause.",
    });
    expect(refs).toEqual(["mt#1706"]);
  });

  test("a BARE task mention is not a retirement clause", () => {
    // The precision case the module exists to protect: memories cite tasks constantly for
    // ordinary cross-reference. Matching those would annotate nearly the whole corpus.
    const { refs } = extractTrackingTaskRefs({
      content:
        "See mt#4345 for the ingest defect. Related: mt#2534, mt#3170. Filed alongside mt#1234.",
    });
    expect(refs).toEqual([]);
  });

  test("a conditional clause needs a retirement anchor on its own line", () => {
    // The measured false positive (mem#96, "Cockpit v0 task cluster"): a subtask bullet
    // read "push transport (polling v0 → SSE migration when mt#1001 lands)". That schedules
    // OTHER work; it says nothing about whether the memory holding it is still true.
    const scheduling = extractTrackingTaskRefs({
      content:
        "- **mt#1148** — Subtask E: push transport (polling v0 → SSE migration when mt#1001 lands)",
    });
    expect(scheduling.refs).toEqual([]);

    // Same grammatical form, but anchored to the memory's own lifetime — this must fire.
    const retirement = extractTrackingTaskRefs({
      content: "This is a bridge; it holds until mt#1001 lands.",
    });
    expect(retirement.refs).toEqual(["mt#1001"]);
  });

  test("an anchor on a NEIGHBOURING line does not vouch for a clause", () => {
    // Anchor containment: the false positive lived in a bulleted list, where a stray
    // "bridge" one bullet up would otherwise license every conditional below it.
    const { refs } = extractTrackingTaskRefs({
      content: [
        "- This entry is a bridge for something else entirely.",
        "- Subtask E: push transport, scheduled for when mt#1001 lands",
      ].join("\n"),
    });
    expect(refs).toEqual([]);
  });

  test("the anchor may follow the clause, not only precede it", () => {
    // "Once mt#X ships, delete this" is a canonical phrasing; a backwards-only anchor
    // scan would silently drop it.
    const { refs } = extractTrackingTaskRefs({
      content: "Once mt#1703 ships, delete this memory.",
    });
    expect(refs).toEqual(["mt#1703"]);
  });

  test("prefers the structured association over the text scan", () => {
    const { refs, source } = extractTrackingTaskRefs({
      content: BUDGET_CLAUSE,
      associations: { tracksTask: ["mt#9998"] },
    });
    expect(refs).toEqual(["mt#9998"]);
    expect(source).toBe("associations");
  });

  test("an association map WITHOUT tracksTask falls through to the text scan", () => {
    // ADR-012's map is empty across the live corpus (mt#4448), so an absent key means
    // "not backfilled", never "no tracking task exists".
    const { refs, source } = extractTrackingTaskRefs({
      content: BUDGET_CLAUSE,
      associations: { relatedTask: ["mt#5555"] },
    });
    expect(refs).toEqual([TRACKED_TASK]);
    expect(source).toBe("text");
  });

  test("deduplicates repeated refs and normalizes case", () => {
    const { refs } = extractTrackingTaskRefs({
      content: `${TRACKING_CLAUSE}. Retire when MT#1700 ships. Until ${TRACKED_TASK} lands.`,
    });
    expect(refs).toEqual([TRACKED_TASK]);
  });

  test("is not order-dependent across calls (global regex lastIndex is reset)", () => {
    const record = { content: TRACKING_CLAUSE };
    expect(extractTrackingTaskRefs(record).refs).toEqual([TRACKED_TASK]);
    expect(extractTrackingTaskRefs(record).refs).toEqual([TRACKED_TASK]);
    expect(extractTrackingTaskRefs(record).refs).toEqual([TRACKED_TASK]);
  });
});

describe("computeStaleness", () => {
  test("no clause produces no staleness field at all", () => {
    expect(detect({ content: "Just an ordinary memory." }, {})).toBeUndefined();
  });

  test("clause referencing a DONE task is stale", () => {
    const result = detect({ content: BUDGET_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    expect(result?.outcome).toBe("stale");
    expect(result?.completedTasks).toEqual([{ taskId: TRACKED_TASK, status: "DONE" }]);
  });

  test("CLOSED counts as completed alongside DONE", () => {
    const result = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "CLOSED" });
    expect(result?.outcome).toBe("stale");
    expect(result?.completedTasks[0]?.status).toBe("CLOSED");
  });

  test.each(["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "BLOCKED"])(
    "clause referencing a %s task is current, not stale",
    (status) => {
      const result = detect({ content: BUDGET_CLAUSE }, { [TRACKED_TASK]: status });
      expect(result?.outcome).toBe("current");
      expect(result?.completedTasks).toEqual([]);
    }
  );

  test("mixed statuses report only the completed ones as stale", () => {
    const result = detect(
      {
        content:
          `${TRACKING_CLAUSE}. Also superseded by mt#1701. ` +
          `This bridge holds until mt#1702 ships.`,
      },
      { [TRACKED_TASK]: "DONE", "mt#1701": "TODO", "mt#1702": "CLOSED" }
    );
    expect(result?.outcome).toBe("stale");
    expect(result?.completedTasks.map((t) => t.taskId).sort()).toEqual([TRACKED_TASK, "mt#1702"]);
  });

  test("an unknown task id is UNRESOLVED, never current", () => {
    // The graceful-fallback acceptance test: a nonexistent task must not crash, and must
    // not be silently reported as "nothing is stale".
    const result = detect({ content: `Budget: retire when ${UNKNOWN_TASK} ships.` }, {});
    expect(result?.outcome).toBe("unresolved");
    expect(result?.unresolvedTasks).toEqual([UNKNOWN_TASK]);
    expect(result?.completedTasks).toEqual([]);
  });

  test("an explicitly-undefined status is treated the same as a missing key", () => {
    const result = computeStaleness([TRACKED_TASK], "text", new Map([[TRACKED_TASK, undefined]]));
    expect(result?.outcome).toBe("unresolved");
  });

  test("a completed task wins over an unresolved sibling", () => {
    const result = detect(
      { content: `${TRACKING_CLAUSE}. This bridge holds until ${UNKNOWN_TASK} ships.` },
      { [TRACKED_TASK]: "DONE" }
    );
    expect(result?.outcome).toBe("stale");
    expect(result?.unresolvedTasks).toEqual([UNKNOWN_TASK]);
  });
});

describe("renderStalenessNote — the silence contract", () => {
  test("renders text only for a stale verdict", () => {
    const stale = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    const note = renderStalenessNote(stale);
    expect(note).toContain("POSSIBLY OBSOLETE");
    expect(note).toContain(TRACKED_TASK);
  });

  test("renders NOTHING for a current verdict", () => {
    const current = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "TODO" });
    expect(current?.outcome).toBe("current");
    expect(renderStalenessNote(current)).toBeUndefined();
  });

  test("renders NOTHING for an unresolved verdict — no speculative annotation", () => {
    const unresolved = detect({ content: `Tracking task: ${UNKNOWN_TASK}` }, {});
    expect(unresolved?.outcome).toBe("unresolved");
    expect(renderStalenessNote(unresolved)).toBeUndefined();
  });

  test("renders NOTHING when there is no staleness field", () => {
    expect(renderStalenessNote(undefined)).toBeUndefined();
  });

  test("the note names every completed task", () => {
    const result = detect(
      { content: `${TRACKING_CLAUSE}. Superseded by mt#1701.` },
      { [TRACKED_TASK]: "DONE", "mt#1701": "CLOSED" }
    );
    const note = renderStalenessNote(result);
    expect(note).toContain(TRACKED_TASK);
    expect(note).toContain("mt#1701");
  });

  test("the note does NOT assert the memory is wrong — it asks the reader to verify", () => {
    // The annotation states an observed delta; the reader decides. Asserting obsolescence
    // would be a verdict the detector has no standing to reach.
    const note = renderStalenessNote(
      detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" })
    );
    expect(note).toContain("may already have shipped");
    expect(note).toContain("verify before");
  });
});
