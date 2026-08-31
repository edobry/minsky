/**
 * Tests for the memory-staleness detection core (mt#1709).
 *
 * The module is a pure functional core with injected lookups, so everything here runs
 * against object literals and a `Map` — no database, no service, no patching.
 */

import { describe, expect, test } from "bun:test";
import {
  collectUnresolvedRefs,
  combineStaleness,
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

/**
 * ADR-024 Rung 1 — quotation-aware prefilter (mt#4454).
 *
 * The two positive fixtures are the VERBATIM sentences from the live records that produced the
 * false positives, not paraphrases. That matters: the defect is about how real prose is
 * punctuated, and a synthetic rewrite would silently normalise away the very characters under
 * test (mem#1020 — an inert fixture proves nothing about the corpus it stands in for).
 */
describe("extractTrackingTaskRefs — quotation prefilter (mt#4454)", () => {
  /** mem#484 `## Originating incident`, verbatim. A clause it quotes from ANOTHER memory. */
  const MEM_484_SENTENCE =
    "2026-05-23, mt#2056 closeout. Bridge memory `70ba7f79` had a budget criterion: " +
    '"retire when mt#2056 ships AND a fresh agent observably follows the restored §9." ' +
    "Condition 2 had no mechanism — no actor was assigned to observe or execute the retirement.";

  /** mem#1340's discrimination-control table, verbatim. The detector's own documented fixture. */
  const MEM_1340_CONTROL = [
    "- `Retire when mt#1541 ships.` → HIT",
    "- `Retire when the detector extension to mt#1541 ships.` → MISS",
  ].join("\n");

  /** mem#315's DESCRIPTION clause, verbatim. A genuine self-declared budget that must survive. */
  const MEM_315_DESCRIPTION =
    'When encoding a "temporary" / "escape hatch" / "workaround" / "interim" / "until X ships" ' +
    "mechanism, cite both a tracking task and an escalation threshold (count, window, or both). " +
    "Without a budget, temporary becomes permanent — memory describes but doesn't act. " +
    "Bridge until mt#1034 attention-allocation noticer ships.";

  test("AT1: a clause quoted in PROSE QUOTES does not fire (mem#484, verbatim)", () => {
    expect(extractTrackingTaskRefs({ content: MEM_484_SENTENCE }).refs).toEqual([]);
  });

  test("AT3b: a clause inside an inline CODE SPAN does not fire (mem#1340, verbatim)", () => {
    expect(extractTrackingTaskRefs({ content: MEM_1340_CONTROL }).refs).toEqual([]);
  });

  test("AT2: mem#315's genuine self-declared clause STILL fires (false-negative guard)", () => {
    // The pair is the point. A fix that only silences mem#484 is indistinguishable from one
    // that silences the detector, and only this assertion separates them.
    expect(extractTrackingTaskRefs({ description: MEM_315_DESCRIPTION, content: "" }).refs).toEqual(
      ["mt#1034"]
    );
  });

  test("AT3: a clause inside a fenced code block does not fire", () => {
    const content = [
      "Here is the shape we match:",
      "```",
      "Retire when mt#2222 ships.",
      "```",
    ].join("\n");
    expect(extractTrackingTaskRefs({ content }).refs).toEqual([]);
  });

  test("AT4: a clause inside a `>` blockquote line does not fire", () => {
    const content = "The prior memory said:\n\n> Budget: retire when mt#3333 ships.\n";
    expect(extractTrackingTaskRefs({ content }).refs).toEqual([]);
  });

  test("AT5: both straight and curly double quotes elide", () => {
    expect(
      extractTrackingTaskRefs({ content: 'It said "retire when mt#4444 ships" and moved on.' }).refs
    ).toEqual([]);
    expect(
      extractTrackingTaskRefs({ content: "It said “retire when mt#5555 ships” and moved on." }).refs
    ).toEqual([]);
  });

  test("AT6: an ordinary UNQUOTED clause still fires (regression guard)", () => {
    expect(extractTrackingTaskRefs({ content: "Budget: retire when mt#6666 ships." }).refs).toEqual(
      ["mt#6666"]
    );
  });

  test("AT6b: over-elision guard — a genuine clause carrying inline code still fires", () => {
    // The discriminating shape for criterion 3. NOTE the code span is NOT the task id: a
    // backticked id (`` retire when `mt#X` ships ``) extracts nothing even before this change,
    // because the backtick breaks the pattern's `\s+` — so that shape cannot tell over-elision
    // apart from a pre-existing miss, and asserting on it would be a test of nothing.
    expect(
      extractTrackingTaskRefs({
        content: "Tracking task: mt#7777 — see `packages/domain/src/memory/staleness.ts`.",
      }).refs
    ).toEqual(["mt#7777"]);
  });

  test("the ANCHOR may sit inside a code span and still vouch for its clause", () => {
    // The anchor is read from the RAW text at the match offset, not the elided text. A
    // decorated anchor is ordinary in this corpus, and blanking it would drop a genuine
    // clause for a reason unrelated to quotation.
    expect(
      extractTrackingTaskRefs({ content: "`Budget:` this holds until mt#8888 lands." }).refs
    ).toEqual(["mt#8888"]);
  });

  test("elision preserves offsets, so same-line anchor containment still holds", () => {
    // The mem#96 containment guard, re-asserted THROUGH the elider: a stray anchor one bullet
    // up must not license a conditional below it. Same-length blanking is what keeps
    // `hasRetirementAnchor`'s line bounds pointing at the right line.
    const content = [
      "- This entry is a `bridge` for something else entirely.",
      "- Subtask E: push transport, scheduled for when mt#1001 lands",
    ].join("\n");
    expect(extractTrackingTaskRefs({ content }).refs).toEqual([]);
  });

  test("a quoted clause and a real one in the same record yields only the real one", () => {
    const content = [
      'The older note said "retire when mt#1111 ships", which was never acted on.',
      "Budget: retire when mt#2222 ships.",
    ].join("\n");
    expect(extractTrackingTaskRefs({ content }).refs).toEqual(["mt#2222"]);
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

describe("combineStaleness — the two triggers are independent (mt#4452)", () => {
  const DECAY = {
    measuredOn: "2026-07-30",
    ageDays: 23,
    matchedSentence: "Measured on prod 2026-07-30",
    subsystems: ["turn-writer.ts"],
    interveningTasks: [{ taskId: "mt#4345", title: "ingest rewrites every turn" }],
  };

  test("neither trigger fires → no verdict", () => {
    expect(combineStaleness(undefined, undefined)).toBeUndefined();
  });

  test("only trigger 1 → its verdict is returned unchanged", () => {
    const t1 = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    if (!t1) throw new Error("expected a trigger-1 verdict for the fixture");
    // Identity, not equality: with no measurement there is nothing to combine, so the same
    // object should come back rather than a reconstructed copy.
    expect(combineStaleness(t1, undefined)).toBe(t1);
  });

  test("only trigger 2 → stale, with empty tracking-task fields (mem#773's shape)", () => {
    const combined = combineStaleness(undefined, DECAY);
    expect(combined?.outcome).toBe("stale");
    expect(combined?.completedTasks).toEqual([]);
    expect(combined?.note).toContain("MEASUREMENT MAY BE STALE");
    expect(combined?.measurement?.interveningTasks[0]?.taskId).toBe("mt#4345");
  });

  test("trigger 2 PROMOTES a `current` trigger-1 verdict to stale", () => {
    // An open tracking task says nothing about whether the record's numbers still hold, so
    // the measurement finding is not subordinate to it.
    const t1 = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "TODO" });
    expect(t1?.outcome).toBe("current");
    expect(combineStaleness(t1, DECAY)?.outcome).toBe("stale");
  });

  test("both fire → both notes are carried", () => {
    const t1 = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    const note = combineStaleness(t1, DECAY)?.note;
    expect(note).toContain("POSSIBLY OBSOLETE");
    expect(note).toContain("MEASUREMENT MAY BE STALE");
  });

  test("combining preserves trigger 1's completed tasks", () => {
    const t1 = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    expect(combineStaleness(t1, DECAY)?.completedTasks[0]?.taskId).toBe(TRACKED_TASK);
  });
});

describe("collectUnresolvedRefs — AT4's warning decision", () => {
  test("reports a memory whose tracking task id does not resolve", () => {
    const staleness = detect({ content: `Tracking task: ${UNKNOWN_TASK}` }, {});
    expect(collectUnresolvedRefs([{ memoryId: "mem-1", staleness }])).toEqual([
      { memoryId: "mem-1", taskIds: [UNKNOWN_TASK] },
    ]);
  });

  test("reports nothing for a current verdict", () => {
    const staleness = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "TODO" });
    expect(collectUnresolvedRefs([{ memoryId: "mem-1", staleness }])).toEqual([]);
  });

  test("reports nothing for a stale verdict, even with an unresolved sibling", () => {
    // A stale verdict resolved what it needed to. The annotation already fired; a warning
    // about the sibling would be noise on a path that is working.
    const staleness = detect(
      { content: `${TRACKING_CLAUSE}. This bridge holds until ${UNKNOWN_TASK} ships.` },
      { [TRACKED_TASK]: "DONE" }
    );
    expect(staleness?.outcome).toBe("stale");
    expect(collectUnresolvedRefs([{ memoryId: "mem-1", staleness }])).toEqual([]);
  });

  test("reports nothing when there is no staleness verdict at all", () => {
    expect(collectUnresolvedRefs([{ memoryId: "mem-1", staleness: undefined }])).toEqual([]);
  });

  test("reports each affected memory separately across a result page", () => {
    const a = detect({ content: `Tracking task: ${UNKNOWN_TASK}` }, {});
    const b = detect({ content: TRACKING_CLAUSE }, { [TRACKED_TASK]: "DONE" });
    const c = detect({ content: "Tracking task: mt#88888" }, {});
    expect(
      collectUnresolvedRefs([
        { memoryId: "mem-1", staleness: a },
        { memoryId: "mem-2", staleness: b },
        { memoryId: "mem-3", staleness: c },
      ])
    ).toEqual([
      { memoryId: "mem-1", taskIds: [UNKNOWN_TASK] },
      { memoryId: "mem-3", taskIds: ["mt#88888"] },
    ]);
  });
});

describe("anchor scanning is line-bounded — the documented precision trade-off", () => {
  // PR #3258 R1 (non-blocking): the line bound is deliberate, and until now only the
  // false-positive direction was pinned. These lock the cost side too, so a future widening
  // has to change a test rather than silently alter the trade-off.

  test("a clause wrapped onto the line AFTER its anchor does not fire", () => {
    // The known cost of line-bounding. Hard-wrapped prose splits anchor from clause, and
    // this is accepted rather than fixed — the alternative re-admits mem#96's shape.
    const { refs } = extractTrackingTaskRefs({
      content: "This entry is a bridge, and it\nremains in force until mt#1001 lands.",
    });
    expect(refs).toEqual([]);
  });

  test("the same clause fires when anchor and clause share a line", () => {
    const { refs } = extractTrackingTaskRefs({
      content: "This entry is a bridge, and it remains in force until mt#1001 lands.",
    });
    expect(refs).toEqual(["mt#1001"]);
  });

  test("an anchor beyond the character window does not reach the clause", () => {
    const filler = "x".repeat(200);
    const { refs } = extractTrackingTaskRefs({
      content: `This is a bridge ${filler} until mt#1001 lands.`,
    });
    expect(refs).toEqual([]);
  });

  test("self-anchored patterns are unaffected by line bounding", () => {
    // Only the conditional family consults the anchor; "Tracking task:" stands alone.
    const { refs } = extractTrackingTaskRefs({
      content: "Some unrelated line.\nTracking task: mt#1001\nAnother unrelated line.",
    });
    expect(refs).toEqual(["mt#1001"]);
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
