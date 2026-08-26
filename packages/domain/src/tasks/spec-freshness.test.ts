/**
 * Tests for the spec-freshness recheck detection core (mt#2826, mt#4415, mt#4420).
 *
 * @see spec-freshness.ts
 */
import { describe, test, expect } from "bun:test";
import { checkSpecFreshness, type SpecFreshnessDeps } from "./spec-freshness";

const SPEC_UPDATED_AT = new Date("2026-07-15T17:37:02.956Z");

/**
 * A spec authored and never edited since — `created_at === updated_at`, which
 * is 34% of the real corpus (1,564 of 4,535 specs). The pre-mt#4420 tests were
 * written when the only baseline was the last edit, so this is the shape that
 * preserves their meaning exactly: with the two timestamps equal, the floor and
 * the classification boundary coincide and the comparison is the old one.
 */
function neverEdited(at: Date) {
  return { updatedAt: at, createdAt: at };
}

function makeDeps(overrides: Partial<SpecFreshnessDeps> = {}): SpecFreshnessDeps {
  return {
    getTaskInfo: async () => null,
    getChangesetInfo: async () => null,
    ...overrides,
  };
}

describe("checkSpecFreshness", () => {
  test("a task ref that went DONE after the spec's updatedAt produces a drift row", async () => {
    const refUpdatedAt = new Date("2026-07-16T03:09:38.578Z"); // after SPEC_UPDATED_AT
    const deps = makeDeps({
      getTaskInfo: async (refTaskId) => {
        expect(refTaskId).toBe("mt#2812");
        return { status: "DONE", updatedAt: refUpdatedAt };
      },
    });

    const result = await checkSpecFreshness(
      "mt#2806",
      "This umbrella depends on mt#2812 shipping first.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(result.hasDrift).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      ref: "mt#2812",
      kind: "task",
      currentStatus: "DONE",
      refUpdatedAt: refUpdatedAt.toISOString(),
      precedesLastSpecEdit: false,
    });
    expect(result.drift[0]?.daysSinceSpecEdit).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("a spec whose cited refs are all unchanged since authoring produces zero drift (silent)", async () => {
    const staleRefUpdatedAt = new Date("2026-07-10T00:00:00.000Z"); // before SPEC_UPDATED_AT
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "IN-PROGRESS", updatedAt: staleRefUpdatedAt }),
      getChangesetInfo: async () => ({ status: "open", updatedAt: staleRefUpdatedAt }),
    });

    const result = await checkSpecFreshness(
      "mt#2826",
      "Related to mt#2534 and PR #1929.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
  });

  test("a PR ref merged after the spec's updatedAt produces a drift row", async () => {
    const mergedAt = new Date("2026-07-16T12:00:00.000Z");
    const deps = makeDeps({
      getChangesetInfo: async (prNumber) => {
        expect(prNumber).toBe("1929");
        return { status: "merged", updatedAt: mergedAt };
      },
    });

    const result = await checkSpecFreshness(
      "mt#2826",
      "Depends on PR #1929 landing.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(result.hasDrift).toBe(true);
    expect(result.drift).toEqual([
      {
        ref: "PR #1929",
        kind: "pr",
        currentStatus: "merged",
        refUpdatedAt: mergedAt.toISOString(),
        daysSinceSpecEdit: expect.any(Number),
        precedesLastSpecEdit: false,
      },
    ]);
  });

  test("excludes the citing task's own ID from its ref list (no self-drift)", async () => {
    let called = false;
    const deps = makeDeps({
      getTaskInfo: async () => {
        called = true;
        return { status: "DONE", updatedAt: new Date("2026-07-16T00:00:00.000Z") };
      },
    });

    const result = await checkSpecFreshness(
      "mt#2826",
      "Task mt#2826: spec-freshness recheck.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(called).toBe(false);
    expect(result.hasDrift).toBe(false);
  });

  test("a ref that cannot be resolved is skipped, not treated as drift or an error", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => null,
    });

    const result = await checkSpecFreshness(
      "mt#2826",
      "See mt#9999999 for context.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(result.hasDrift).toBe(false);
    expect(result.skipped).toEqual([{ ref: "mt#9999999", reason: "task not found" }]);
  });

  test("a ref with no tracked updatedAt (e.g. GitHub Issues backend) is skipped, not flagged", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "TODO", updatedAt: undefined }),
    });

    const result = await checkSpecFreshness(
      "mt#2826",
      "Blocked by gh#42.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    // gh#42 doesn't match the mt#N pattern so it won't even be extracted —
    // use an mt# ref instead to exercise the "no updatedAt" skip path.
    const result2 = await checkSpecFreshness(
      "mt#2826",
      "Blocked by mt#42.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(result.hasDrift).toBe(false);
    expect(result2.hasDrift).toBe(false);
    expect(result2.skipped).toEqual([
      { ref: "mt#42", reason: "no updatedAt tracked for this task's backend" },
    ]);
  });

  test("a spec with no tracked timestamps skips the check entirely (no baseline to compare against)", async () => {
    const deps = makeDeps();

    const result = await checkSpecFreshness("mt#2826", "Cites mt#2812.", {}, deps);

    expect(result.specUpdatedAt).toBeNull();
    expect(result.specCreatedAt).toBeNull();
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
  });

  test("no baseline reports checked: false, so it is distinguishable from a clean pass (mt#4415)", async () => {
    // The ref HAS drifted; the point is that with no baseline the check cannot
    // know that, and must not answer as though it had looked.
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: new Date("2026-08-19T20:26:00Z") }),
    });

    const notChecked = await checkSpecFreshness("mt#2826", "Cites mt#2812.", {}, deps);
    const cleanPass = await checkSpecFreshness(
      "mt#2826",
      "Cites mt#2812.",
      neverEdited(new Date("2026-08-20T00:00:00Z")), // later than the ref's change — genuinely clean
      deps
    );

    // Both report hasDrift: false. Only `checked` separates them, which is the
    // whole reason the field exists.
    expect(notChecked.hasDrift).toBe(false);
    expect(cleanPass.hasDrift).toBe(false);
    expect(notChecked.checked).toBe(false);
    expect(cleanPass.checked).toBe(true);

    expect(notChecked.skipped).toEqual([
      {
        ref: "*",
        reason:
          "no spec-content timestamp for this task's backend — no baseline to compare against, so no refs were checked",
      },
    ]);
    expect(cleanPass.skipped).toHaveLength(0);
  });

  test("a completed comparison reports checked: true whether or not drift was found", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: new Date("2026-07-16T03:09:38Z") }),
    });

    const drifted = await checkSpecFreshness(
      "mt#2806",
      "Cites mt#2812.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );
    const noRefs = await checkSpecFreshness(
      "mt#2806",
      "Cites nothing.",
      neverEdited(SPEC_UPDATED_AT),
      deps
    );

    expect(drifted.checked).toBe(true);
    expect(drifted.hasDrift).toBe(true);
    expect(noRefs.checked).toBe(true);
    expect(noRefs.hasDrift).toBe(false);
  });
});

/**
 * mt#4420 — the baseline must be a floor an incidental edit cannot move.
 *
 * Shared timeline across this block:
 *
 *   AUTHORED 08-20 ──── ref drifts 08-22 ──── spec EDITED 08-26
 *
 * The edit touched some unrelated section. Under the pre-mt#4420 comparison the
 * baseline was the 08-26 edit, so the 08-22 drift sat below it and vanished.
 */
describe("checkSpecFreshness — the floor is the authoring timestamp (mt#4420)", () => {
  const AUTHORED = new Date("2026-08-20T00:00:00.000Z");
  const REF_DRIFTED = new Date("2026-08-22T00:00:00.000Z");
  const EDITED = new Date("2026-08-26T00:00:00.000Z");
  const SPEC_CITING_ONE_REF = "Depends on mt#4186.";

  test("AT1 — a ref that drifted BEFORE the citing session's own edit is still reported", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: REF_DRIFTED }),
    });

    const result = await checkSpecFreshness(
      "mt#4232",
      "Depends on mt#4186 (IN-REVIEW, Summary read).",
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );

    expect(result.hasDrift).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      ref: "mt#4186",
      currentStatus: "DONE",
      refUpdatedAt: REF_DRIFTED.toISOString(),
      // The whole point: this drift predates the last edit and is reported anyway.
      precedesLastSpecEdit: true,
    });
    // Signed relative to the last edit — negative means "drifted N days before it".
    expect(result.drift[0]?.daysSinceSpecEdit).toBeLessThan(0);
    expect(result.baselineUsed).toBe("spec-authored");
  });

  test("AT2 — a genuinely-stale ref and a self-touched one are BOTH reported, and told apart (mem#1091)", async () => {
    // The mem#1091 replay: mt#4186 had gone DONE days earlier and was absent
    // from the drift array, while mt#4040 — patched by the checking session
    // seconds before — was the array's only entry. The result LOOKED like a
    // finding, which is what made the miss invisible.
    const selfTouched = new Date("2026-08-26T00:00:19.000Z"); // 19s after the edit
    const deps = makeDeps({
      getTaskInfo: async (ref) =>
        ref === "mt#4186"
          ? { status: "DONE", updatedAt: REF_DRIFTED }
          : { status: "PLANNING", updatedAt: selfTouched },
    });

    const result = await checkSpecFreshness(
      "mt#4232",
      "Depends on mt#4186. See also mt#4040.",
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );

    const byRef = Object.fromEntries(result.drift.map((d) => [d.ref, d]));
    expect(Object.keys(byRef).sort()).toEqual(["mt#4040", "mt#4186"]);

    // The genuinely-stale ref is present and marked as predating the edit.
    expect(byRef["mt#4186"]?.precedesLastSpecEdit).toBe(true);
    // The self-touched one is present too, and marked as NOT predating it —
    // so a reader can see the array is not composed solely of its own edits.
    expect(byRef["mt#4040"]?.precedesLastSpecEdit).toBe(false);
    expect(result.drift.every((d) => d.precedesLastSpecEdit)).toBe(false);
    expect(result.drift.some((d) => d.precedesLastSpecEdit)).toBe(true);
  });

  test("AT3 — a ref last changed BEFORE the spec was authored is still not reported", async () => {
    const beforeAuthoring = new Date("2026-08-19T00:00:00.000Z");
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: beforeAuthoring }),
      getChangesetInfo: async () => ({ status: "merged", updatedAt: beforeAuthoring }),
    });

    const result = await checkSpecFreshness(
      "mt#4232",
      "Context: mt#4186 and PR #1929.",
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );

    // The floor is the authoring time, not the epoch — widening the window must
    // not turn the check into "report every ref that ever changed".
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
  });

  test("a PR ref is classified against the last edit the same way a task ref is", async () => {
    const deps = makeDeps({
      getChangesetInfo: async () => ({ status: "merged", updatedAt: REF_DRIFTED }),
    });

    const result = await checkSpecFreshness(
      "mt#4232",
      "Depends on PR #1929 landing.",
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );

    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.kind).toBe("pr");
    expect(result.drift[0]?.precedesLastSpecEdit).toBe(true);
  });

  test("with no authoring timestamp it degrades to the last edit, and SAYS which baseline it used", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: REF_DRIFTED }),
    });

    const degraded = await checkSpecFreshness(
      "mt#4232",
      SPEC_CITING_ONE_REF,
      { updatedAt: EDITED }, // e.g. a backend that tracks no created_at
      deps
    );

    // Pre-mt#4420 behaviour: the 08-22 drift is below the 08-26 baseline and is
    // not reported. That is a weaker answer, and `baselineUsed` is what lets a
    // caller tell it apart from the full check rather than having to infer it.
    expect(degraded.checked).toBe(true);
    expect(degraded.hasDrift).toBe(false);
    expect(degraded.baselineUsed).toBe("spec-last-edited");
    expect(degraded.specCreatedAt).toBeNull();

    const full = await checkSpecFreshness(
      "mt#4232",
      SPEC_CITING_ONE_REF,
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );
    expect(full.baselineUsed).toBe("spec-authored");
    expect(full.hasDrift).toBe(true);
  });

  test("an authoring timestamp with no recorded edit reports every drift as not-preceding", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: REF_DRIFTED }),
    });

    const result = await checkSpecFreshness(
      "mt#4232",
      SPEC_CITING_ONE_REF,
      { createdAt: AUTHORED }, // no updatedAt at all
      deps
    );

    expect(result.hasDrift).toBe(true);
    // With no recorded edit there is nothing for a ref to precede, so `false`
    // is the accurate answer rather than a degraded one.
    expect(result.drift[0]?.precedesLastSpecEdit).toBe(false);
    expect(result.baselineUsed).toBe("spec-authored");
    expect(result.specUpdatedAt).toBeNull();
  });

  test("exact-instant ties resolve the same way at BOTH boundaries (PR #3389 R1)", async () => {
    // A ref stamped at the SAME millisecond as the last edit did not precede
    // it — and the command renders this count as "BEFORE the spec was last
    // edited", so `<=` would make that sentence false. Batched writes make the
    // collision reachable rather than theoretical.
    const atLastEdit = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: EDITED }),
    });
    const tieOnEdit = await checkSpecFreshness(
      "mt#4232",
      SPEC_CITING_ONE_REF,
      { updatedAt: EDITED, createdAt: AUTHORED },
      atLastEdit
    );

    expect(tieOnEdit.drift).toHaveLength(1);
    expect(tieOnEdit.drift[0]?.precedesLastSpecEdit).toBe(false);
    expect(tieOnEdit.drift[0]?.daysSinceSpecEdit).toBe(0);

    // The floor uses the same convention: a ref exactly AT the authoring
    // timestamp is not drift. Pinned here so the two cannot diverge.
    const atFloor = makeDeps({
      getTaskInfo: async () => ({ status: "DONE", updatedAt: AUTHORED }),
    });
    const tieOnFloor = await checkSpecFreshness(
      "mt#4232",
      SPEC_CITING_ONE_REF,
      { updatedAt: EDITED, createdAt: AUTHORED },
      atFloor
    );

    expect(tieOnFloor.hasDrift).toBe(false);
    expect(tieOnFloor.drift).toHaveLength(0);
  });

  test("both timestamps are echoed back so a caller can see the window it was given", async () => {
    const deps = makeDeps();

    const result = await checkSpecFreshness(
      "mt#4232",
      "Cites nothing.",
      { updatedAt: EDITED, createdAt: AUTHORED },
      deps
    );

    expect(result.specCreatedAt).toBe(AUTHORED.toISOString());
    expect(result.specUpdatedAt).toBe(EDITED.toISOString());
  });
});
