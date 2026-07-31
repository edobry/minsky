/**
 * Tests for the spec-freshness recheck detection core (mt#2826).
 *
 * @see spec-freshness.ts
 */
import { describe, test, expect } from "bun:test";
import { checkSpecFreshness, type SpecFreshnessDeps } from "./spec-freshness";

const SPEC_UPDATED_AT = new Date("2026-07-15T17:37:02.956Z");

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
      SPEC_UPDATED_AT,
      deps
    );

    expect(result.hasDrift).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      ref: "mt#2812",
      kind: "task",
      currentStatus: "DONE",
      refUpdatedAt: refUpdatedAt.toISOString(),
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
      SPEC_UPDATED_AT,
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
      SPEC_UPDATED_AT,
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
      SPEC_UPDATED_AT,
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
      SPEC_UPDATED_AT,
      deps
    );

    expect(result.hasDrift).toBe(false);
    expect(result.skipped).toEqual([{ ref: "mt#9999999", reason: "task not found" }]);
  });

  test("a ref with no tracked updatedAt (e.g. GitHub Issues backend) is skipped, not flagged", async () => {
    const deps = makeDeps({
      getTaskInfo: async () => ({ status: "TODO", updatedAt: undefined }),
    });

    const result = await checkSpecFreshness("mt#2826", "Blocked by gh#42.", SPEC_UPDATED_AT, deps);

    // gh#42 doesn't match the mt#N pattern so it won't even be extracted —
    // use an mt# ref instead to exercise the "no updatedAt" skip path.
    const result2 = await checkSpecFreshness("mt#2826", "Blocked by mt#42.", SPEC_UPDATED_AT, deps);

    expect(result.hasDrift).toBe(false);
    expect(result2.hasDrift).toBe(false);
    expect(result2.skipped).toEqual([
      { ref: "mt#42", reason: "no updatedAt tracked for this task's backend" },
    ]);
  });

  test("a spec with no tracked updatedAt skips the check entirely (no baseline to compare against)", async () => {
    const deps = makeDeps();

    const result = await checkSpecFreshness("mt#2826", "Cites mt#2812.", undefined, deps);

    expect(result.specUpdatedAt).toBeNull();
    expect(result.hasDrift).toBe(false);
    expect(result.drift).toHaveLength(0);
  });
});
