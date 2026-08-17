/**
 * The three `InterceptionPoint` copies must agree (mt#4129).
 *
 * The union is declared three times, and the duplication is structurally forced
 * rather than sloppy: the hook tree may not import from `src/` (mt#4010's
 * generated-artifact boundary, pinned by `hook-tree-import-boundary.test.ts`),
 * and cockpit-web may not import from `.minsky/hooks/**` (the
 * `no-node-import-in-cockpit-web` guard, mt#3239). Nothing structural can make
 * them one declaration, so something has to assert they stay identical.
 *
 * A one-sided widening is silently unenforced coverage, which is this task's own
 * subject: mt#4129 added six points, and without this test, adding them to one
 * copy and not another typechecks clean while the resolver drops every hook
 * registered at the missing events.
 *
 * The reading lives in `scripts/interception-point-sources.ts` — a test may not
 * touch the filesystem (`custom/no-real-fs-in-tests`), and that is the same
 * split `precommit-step-names.ts` already uses.
 */
import { describe, expect, test } from "bun:test";
import {
  readInterceptionPointUnions,
  readPointsGate,
  readValidPoints,
  readDocPoints,
} from "../../scripts/interception-point-sources";

/** The six mt#4129 added; named so deleting them from all three still fails. */
const ADDED_BY_MT4129 = [
  "SessionStart",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
];

describe("InterceptionPoint stays identical across its three declarations", () => {
  const unions = readInterceptionPointUnions();
  const labels = Object.keys(unions);
  const first = labels[0] ?? "";
  /** The reference member list, defaulted rather than asserted non-null. */
  const reference = unions[first] ?? [];

  test("each declaration parses to a non-empty member list", () => {
    expect(labels.length).toBe(3);
    for (const label of labels) {
      expect(unions[label]?.length ?? 0, `${label} parsed no members`).toBeGreaterThan(0);
    }
  });

  test("all three declare exactly the same points", () => {
    for (const label of labels.slice(1)) {
      expect(unions[label], `${label} diverges from ${first}`).toEqual(reference);
    }
  });

  test("the six events mt#4129 added are present in all three", () => {
    // Named explicitly: the equality assertion above passes if someone deletes a
    // point from all three at once, which for these six silently restores the
    // drop this task removed.
    for (const point of ADDED_BY_MT4129) {
      for (const label of labels) {
        expect(unions[label], `${label} is missing ${point}`).toContain(point);
      }
    }
  });

  test("the runtime POINTS gate matches the union", () => {
    // `derivePoint` drops a settings-registered event absent from this Set, so a
    // union member missing here is a point the resolver can never produce — the
    // exact shape that hid six events until mt#4129.
    expect(readPointsGate()).toEqual(reference);
  });

  test("the ontology doc's axis-1 list matches the union (PR #3057 R1)", () => {
    // The sixth copy, and the only one in prose. It went stale in this very PR
    // — the reviewer caught it, nothing else could have. Fenced in
    // `axis-1-points` markers so it is parsed rather than trusted.
    expect(readDocPoints()).toEqual(reference);
  });

  test("the runtime VALID_POINTS validator matches the union", () => {
    // `parseCatalog` THROWS on a point absent from this list, so a stale copy
    // rejects the whole catalog. mt#4129 widened the union and missed it; the
    // pre-commit related-test gate caught it, and this assertion is what makes
    // the next widening cheap instead of a failed commit.
    expect(readValidPoints()).toEqual(reference);
  });
});
