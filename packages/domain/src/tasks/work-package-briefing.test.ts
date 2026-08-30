import { describe, test, expect } from "bun:test";
import { parseWorkPackageBriefing, validateWorkPackageBriefing } from "./work-package-briefing";

const GROOMED_BRIEFING = `# Cockpit polish bundle

Origin: groomed

## Members

1. mt#101 — the list view fix, land first
2. mt#102 — depends on the list view's selector
3. mt#103

## Grouping rationale

All three touch the same widget; one claimant avoids three rebases.
`;

const SUCCESSION_BRIEFING = `# mt#2911 continuation

Origin: succession

## Situation

Increments 1-4 are merged; the create seam is half-wired (see mt#2911).

## Decisions

Chose the task-kind route over a sibling entity (ADR-046) — registry reuse.

## Provenance

Decided by the principal 2026-08-30; RFC §DECIDED. Motivated by mem#676.
`;

describe("parseWorkPackageBriefing", () => {
  test("groomed: origin, ordered members with rationale, sections, cited refs", () => {
    const parsed = parseWorkPackageBriefing(GROOMED_BRIEFING);
    expect(parsed.origin).toBe("groomed");
    expect(parsed.members).toEqual([
      { taskId: "mt#101", rank: 1, rationale: "the list view fix, land first" },
      { taskId: "mt#102", rank: 2, rationale: "depends on the list view's selector" },
      { taskId: "mt#103", rank: 3, rationale: null },
    ]);
    expect(parsed.sections.has("members")).toBe(true);
    expect(parsed.sections.has("grouping rationale")).toBe(true);
    expect(parsed.citedRefs).toEqual(["mt#101", "mt#102", "mt#103"]);
  });

  test("succession: cited refs include task ids and short ids from any section", () => {
    const parsed = parseWorkPackageBriefing(SUCCESSION_BRIEFING);
    expect(parsed.origin).toBe("succession");
    expect(parsed.members).toEqual([]);
    expect(parsed.citedRefs).toEqual(["mt#2911", "mem#676"]);
  });

  test("an illegal origin value is kept as rawOrigin with origin null", () => {
    const parsed = parseWorkPackageBriefing("Origin: release\n\n## Members\n- mt#1\n");
    expect(parsed.origin).toBeNull();
    expect(parsed.rawOrigin).toBe("release");
  });

  test("members section at the end of the briefing (no following heading) still parses", () => {
    const parsed = parseWorkPackageBriefing("Origin: groomed\n\n## Members\n\n- mt#7 — only one");
    expect(parsed.members).toEqual([{ taskId: "mt#7", rank: 1, rationale: "only one" }]);
  });
});

describe("validateWorkPackageBriefing", () => {
  test("valid groomed and succession briefings produce no failures", () => {
    expect(validateWorkPackageBriefing(parseWorkPackageBriefing(GROOMED_BRIEFING))).toEqual([]);
    expect(validateWorkPackageBriefing(parseWorkPackageBriefing(SUCCESSION_BRIEFING))).toEqual([]);
  });

  test("missing origin line is the sole failure reported (nothing else is judged)", () => {
    const failures = validateWorkPackageBriefing(parseWorkPackageBriefing("## Members\n- mt#1\n"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("missing-origin");
  });

  test('release is refused as a create origin — "minted only by the release path"', () => {
    const failures = validateWorkPackageBriefing(
      parseWorkPackageBriefing("Origin: release\n\n## Members\n- mt#1\n")
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("invalid-origin");
    expect(failures[0]?.detail).toContain("release");
  });

  test("groomed briefing missing grouping rationale is refused naming the section", () => {
    const failures = validateWorkPackageBriefing(
      parseWorkPackageBriefing("Origin: groomed\n\n## Members\n- mt#1 — x\n")
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("missing-section");
    expect(failures[0]?.detail).toContain("Grouping rationale");
  });

  test("succession briefing missing situation/decisions is refused naming EVERY gap at once", () => {
    const failures = validateWorkPackageBriefing(
      parseWorkPackageBriefing("Origin: succession\n\n## Provenance\n\nDecided by ask.\n")
    );
    expect(failures.map((f) => f.code)).toEqual(["missing-section", "missing-section"]);
    expect(failures.map((f) => f.detail).join(" ")).toContain("Situation");
    expect(failures.map((f) => f.detail).join(" ")).toContain("Decisions");
  });

  test("succession does NOT demand groomed's sections", () => {
    const failures = validateWorkPackageBriefing(parseWorkPackageBriefing(SUCCESSION_BRIEFING));
    expect(failures).toEqual([]);
  });

  test("groomed members section with no task refs is refused as empty-members", () => {
    const failures = validateWorkPackageBriefing(
      parseWorkPackageBriefing(
        "Origin: groomed\n\n## Members\n\n- fix the thing\n\n## Grouping rationale\n\nBecause.\n"
      )
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("empty-members");
  });
});
