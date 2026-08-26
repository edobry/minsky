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
  readFacetPoints,
  readSpinePoints,
  parseFacetPoints,
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

  test("the /interceptors point facet's option domain matches the union (mt#4603)", () => {
    // The seventh surface, and the one this census did not cover until mt#4603.
    // The facet built its options from INTERCEPTION_POINT_ORDER — a DELIBERATE
    // nine-member subset that is correct for the spine and wrong as a domain —
    // while `matchesFacets` compared against `entry.point` over the full union.
    // Six points were unselectable; `session-start` (SessionStart) and
    // `record-conversation-run-state` (PostCompact) have live catalog entries
    // and could not be filtered to by any choice a reader could make.
    //
    // Compared as SETS, like every sibling assertion here: the facet's render
    // order is a UX choice (trajectory points first, then the six with no
    // trajectory position), while its MEMBERSHIP is the contract. Asserting
    // order would forbid reordering the dropdown, which is not what this
    // protects.
    expect(readFacetPoints()).toEqual(reference);
  });

  test("the spine's subset stays a subset, and stays nine (mt#4603)", () => {
    // The other half of the split: the facet must be complete, and
    // INTERCEPTION_POINT_ORDER must NOT be "fixed" to match it. Its docblock
    // says so, and mt#4129 decided it deliberately — ordering `Notification`
    // against a turn's phases is a spine-design question nobody has answered.
    // Without this, a future reader reconciling the two lists could widen the
    // wrong one and silently invent trajectory placements.
    const spine = readSpinePoints();
    expect(spine.length).toBe(9);
    for (const point of spine) {
      expect(reference, `spine point ${point} is not a union member`).toContain(point);
    }
    for (const point of ADDED_BY_MT4129) {
      expect(spine, `${point} must NOT have a spine station (mt#4129)`).not.toContain(point);
    }
  });

  test("parseFacetPoints survives benign formatting changes (PR #3361 R1)", () => {
    // The reviewer's finding, turned into an assertion. The first version of
    // this parser required a trailing comma on the last key and a newline
    // before the closing brace. Under a formatter that drops the final comma it
    // would have parsed 14 of 15 keys and the census would have reported a
    // mismatch that is an artifact of formatting — a FALSE NEGATIVE in the one
    // assertion whose job is catching a genuinely missing point. Worse than a
    // plain bug: it would look exactly like the defect mt#4603 fixed.
    const canonical = [
      "const INTERCEPTION_POINT_PRESENCE: Record<InterceptionPoint, true> = {",
      "  UserPromptSubmit: true,",
      '  "pre-commit": true,',
      "  PostCompact: true,",
      "};",
    ].join("\n");
    const expected = ["PostCompact", "UserPromptSubmit", "pre-commit"];
    expect(parseFacetPoints(canonical)).toEqual(expected);

    // No trailing comma on the last entry.
    expect(
      parseFacetPoints(canonical.replace("  PostCompact: true,", "  PostCompact: true"))
    ).toEqual(expected);

    // Closing brace on the same line as the last entry — no preceding newline.
    expect(
      parseFacetPoints(
        "const INTERCEPTION_POINT_PRESENCE: Record<InterceptionPoint, true> = {" +
          ' UserPromptSubmit: true, "pre-commit": true, PostCompact: true };'
      )
    ).toEqual(expected);

    // A shape change it SHOULD still reject rather than silently return [].
    expect(() => parseFacetPoints("const SOMETHING_ELSE = { a: true };")).toThrow();
  });

  test("the runtime VALID_POINTS validator matches the union", () => {
    // `parseCatalog` THROWS on a point absent from this list, so a stale copy
    // rejects the whole catalog. mt#4129 widened the union and missed it; the
    // pre-commit related-test gate caught it, and this assertion is what makes
    // the next widening cheap instead of a failed commit.
    expect(readValidPoints()).toEqual(reference);
  });
});
