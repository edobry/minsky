/**
 * mt#3674 — the `tasks_spec_patch` collapse guard.
 *
 * The DECISION (is this delta suspicious?) is pinned in
 * `packages/domain/src/ai/edit-pattern-utils.test.ts`, shared with
 * `session_edit_file`. These tests pin the SPEC-SURFACE refusal: that it fires, that
 * `allowShrink` overrides it, and that the message carries what an operator needs to
 * recover — the two line counts and the actionable cause.
 *
 * Why the detector is injected rather than module-mocked: the handler resolves its
 * domain imports dynamically (mt#1792 lazy-import), so patching the module would test
 * the mock. Injecting keeps this a pure decision over strings.
 */
import { describe, test, expect } from "bun:test";
import {
  assertNoSuspiciousSpecCollapse,
  decideSpecPatchOutcome,
  TASK_SPEC_PATCH_DESCRIPTION,
} from "./task-edit-tools";
import { detectSuspiciousCollapse } from "@minsky/domain/ai/edit-pattern-utils";

const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("assertNoSuspiciousSpecCollapse", () => {
  test("refuses the mt#3339 shape: a long spec collapsed to a single token", () => {
    // The originating incident, verbatim in shape: a ~380-line spec whose merge result
    // was the 7-character string `mt#3672`.
    expect(() =>
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        false,
        detectSuspiciousCollapse
      )
    ).toThrow(/Refusing to patch task mt#3339/);
  });

  test("the refusal names both line counts, the drop, and the override", () => {
    // An operator reading this must be able to tell a collapse from an ordinary failure
    // WITHOUT re-reading the source — and must not be sent to `tasks_edit`, which is the
    // destructive path.
    let message = "";
    try {
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        false,
        detectSuspiciousCollapse
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("380");
    // PR #2650 R1 fixed the plural here and on the two sibling surfaces (shared
    // `formatLineCount`), so this now pins the CORRECT grammar rather than the bug.
    expect(message).toContain("1 line,");
    expect(message).not.toContain("1 lines");
    expect(message).toContain("100% drop");
    expect(message).toContain("allowShrink=true");
    expect(message).toContain("no version history");
  });

  test("allowShrink=true permits an intentional large deletion", () => {
    expect(() =>
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        true,
        detectSuspiciousCollapse
      )
    ).not.toThrow();
  });

  test("an ordinary append-a-section patch is untouched", () => {
    const original = makeLines(200);
    const grown = `${original}\n${makeLines(40)}`;
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", original, grown, false, detectSuspiciousCollapse)
    ).not.toThrow();
  });

  test("an ordinary small correction is untouched", () => {
    const original = makeLines(200);
    const corrected = makeLines(198);
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", original, corrected, false, detectSuspiciousCollapse)
    ).not.toThrow();
  });

  test("a short spec is below the floor and never refused", () => {
    // Deliberate: a ratio on a tiny document is noise. The guard trades this coverage gap
    // for not blocking legitimate edits to short specs.
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", makeLines(20), "x", false, detectSuspiciousCollapse)
    ).not.toThrow();
  });
});

/**
 * PR #2618 R1 (BLOCKING): "Acceptance Test 1's 'spec remains unchanged after refusal' is not
 * asserted." Correct — it was enforced only by statement order plus a comment, which is the
 * same defect class this guard exists to prevent, one level up.
 *
 * These assert the ORDERING as a property of a pure decision, so a refactor that moved the
 * guard below the write or below the dry-run return now fails a test rather than silently
 * shipping. `refuse` is what makes the spec unchanged: the handler's only write path is the
 * `write` outcome, so proving a collapse never yields `write` proves the stored spec survives.
 */
const COLLAPSED = {
  taskId: "mt#3339",
  originalContent: makeLines(380),
  finalContent: "mt#3672",
  wasMarkerMerge: true,
  detect: detectSuspiciousCollapse,
};

describe("decideSpecPatchOutcome — guard ordering (PR #2618 R1)", () => {
  test("a collapse never yields write — this is what leaves the stored spec unchanged", () => {
    const outcome = decideSpecPatchOutcome({ ...COLLAPSED, allowShrink: false, dryRun: false });
    expect(outcome.kind).toBe("refuse");
  });

  test("a collapse outranks dryRun — it refuses rather than rendering an ordinary preview", () => {
    // The ordering that was previously only a comment: guard BEFORE the dry-run return.
    const outcome = decideSpecPatchOutcome({ ...COLLAPSED, allowShrink: false, dryRun: true });
    expect(outcome.kind).toBe("refuse");
  });

  test("the refusal carries the message, so the handler has nothing to re-derive", () => {
    const outcome = decideSpecPatchOutcome({ ...COLLAPSED, allowShrink: false, dryRun: false });
    expect(outcome.kind === "refuse" && outcome.message).toContain("380");
    expect(outcome.kind === "refuse" && outcome.message).toContain("allowShrink=true");
  });

  test("allowShrink restores normal precedence: write, or preview under dryRun", () => {
    expect(decideSpecPatchOutcome({ ...COLLAPSED, allowShrink: true, dryRun: false }).kind).toBe(
      "write"
    );
    expect(decideSpecPatchOutcome({ ...COLLAPSED, allowShrink: true, dryRun: true }).kind).toBe(
      "preview"
    );
  });

  test("an ordinary merge writes, and previews under dryRun", () => {
    const ordinary = {
      taskId: "mt#1",
      originalContent: makeLines(200),
      finalContent: `${makeLines(200)}\nnew section`,
      wasMarkerMerge: true,
      detect: detectSuspiciousCollapse,
    };
    expect(decideSpecPatchOutcome({ ...ordinary, allowShrink: false, dryRun: false }).kind).toBe(
      "write"
    );
    expect(decideSpecPatchOutcome({ ...ordinary, allowShrink: false, dryRun: true }).kind).toBe(
      "preview"
    );
  });

  test("a non-merge write (new spec, no markers) is never guarded", () => {
    // `wasMarkerMerge: false` is the brand-new-spec path, where `finalContent` is the caller's
    // literal content rather than a model's output — there is no merge to have collapsed.
    const outcome = decideSpecPatchOutcome({
      ...COLLAPSED,
      wasMarkerMerge: false,
      allowShrink: false,
      dryRun: false,
    });
    expect(outcome.kind).toBe("write");
  });
});

describe("AT4 — the description tells a caller which shape to use for an append (mt#4181)", () => {
  // The acceptance test is literally "a caller reading only the tool description can tell which
  // mode to use for an append", so it is asserted against the description STRING rather than
  // against prose in a spec somewhere. That is also why the description is hoisted to a constant:
  // a contract that has to be scraped out of a source file to be checked is one nothing checks.

  test("names the APPEND shape and what it looks like", () => {
    expect(TASK_SPEC_PATCH_DESCRIPTION).toContain("APPEND");
    expect(TASK_SPEC_PATCH_DESCRIPTION).toMatch(/lone leading .*existing code/i);
  });

  test("names all three deterministic shapes, so the anchored case is discoverable too", () => {
    for (const shape of ["APPEND", "PREPEND", "ANCHORED"]) {
      expect(TASK_SPEC_PATCH_DESCRIPTION).toContain(shape);
    }
  });

  test("states that no separate append tool exists — the miss this task was filed for", () => {
    // Agents hitting the collapse reached for `tasks_edit` wholesale replacement instead, which
    // is the unguarded path (mt#4082). The description has to close that off explicitly.
    expect(TASK_SPEC_PATCH_DESCRIPTION).toMatch(/no separate append tool/i);
  });

  test("still documents the collapse guard and the fallback, so the change reads as additive", () => {
    expect(TASK_SPEC_PATCH_DESCRIPTION).toContain("COLLAPSE-GUARD (mt#3674)");
    expect(TASK_SPEC_PATCH_DESCRIPTION).toMatch(/falls back to the fast-apply model/i);
  });
});
