import { describe, test, expect } from "bun:test";
import {
  MEMBERS_HEADING,
  TRANSFERS_HEADING,
  parseWorkPackageBriefing,
  renderMembersSection,
  renderTransferLog,
  upsertBriefingSection,
  validateWorkPackageBriefing,
} from "./work-package-briefing";

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

// ---------------------------------------------------------------------------
// mt#5133 — rendering back into the briefing
// ---------------------------------------------------------------------------

const T0 = new Date(Date.UTC(2026, 8, 13, 10, 0, 0));
const T1 = new Date(Date.UTC(2026, 8, 13, 11, 0, 0));
const T2 = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));

const THREE_TRANSFERS = [
  { seq: 1, origin: "groomed", byConversation: "proc:aaa", notes: "curated", createdAt: T0 },
  {
    seq: 2,
    origin: "succession",
    byConversation: "conv:bbb",
    notes: "shipped mt#1;\nmt#2 remains",
    createdAt: T1,
  },
  { seq: 3, origin: "release", byConversation: null, notes: null, createdAt: T2 },
];

describe("renderTransferLog (mt#5133 AT4)", () => {
  test("three transfers render in seq order with origin, time, writer and notes", () => {
    // Handed out of seq order: the renderer sorts, so the list never depends on read order.
    const rendered = renderTransferLog([...THREE_TRANSFERS].reverse());
    const lines = rendered.split("\n");
    expect(lines[0]).toBe(TRANSFERS_HEADING);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("- #1 groomed — 2026-09-13T10:00:00.000Z — by proc:aaa — curated");
    // Multi-line notes collapse onto the transfer's one line.
    expect(lines[3]).toBe(
      "- #2 succession — 2026-09-13T11:00:00.000Z — by conv:bbb — shipped mt#1; mt#2 remains"
    );
    expect(lines[4]).toBe("- #3 release — 2026-09-13T12:00:00.000Z — by unrecorded");
    expect(lines).toHaveLength(5);
  });

  test("an empty log renders the heading with a placeholder item", () => {
    expect(renderTransferLog([])).toBe(`${TRANSFERS_HEADING}\n\n- none recorded`);
  });

  test("the rendered section is parser-inert: origin, members and validation are unchanged", () => {
    const withTransfers = `${SUCCESSION_BRIEFING}\n${renderTransferLog(THREE_TRANSFERS)}\n`;
    const before = parseWorkPackageBriefing(SUCCESSION_BRIEFING);
    const after = parseWorkPackageBriefing(withTransfers);
    expect(after.origin).toBe(before.origin);
    expect(after.members).toEqual(before.members);
    expect(after.sections.has("transfers")).toBe(true);
    expect(validateWorkPackageBriefing(after)).toEqual([]);
  });
});

describe("parseMembersSection: emphasis-wrapped refs", () => {
  test("a `**mt#N**` or backticked ref does not leak its closing marker into the rationale", () => {
    const parsed = parseWorkPackageBriefing(
      "Origin: groomed\n\n## Members\n\n- **mt#5122** — TODO — lifecycle hygiene\n- `mt#7` — second\n- mt#8 — **important** first\n"
    );
    expect(parsed.members.map((m) => m.rationale)).toEqual([
      "TODO — lifecycle hygiene",
      "second",
      "**important** first",
    ]);
  });

  test("a marker after the ref with no matching opener is rationale, not a closer (PR #3751 R1)", () => {
    const parsed = parseWorkPackageBriefing(
      "Origin: groomed\n\n## Members\n\n- mt#8 _italic lead_ then text\n- mt#9**bold lead** text\n- **mt#10** — closed\n"
    );
    expect(parsed.members.map((m) => m.rationale)).toEqual([
      "_italic lead_ then text",
      "**bold lead** text",
      "closed",
    ]);
  });

  test("a ref listed twice keeps its first position; ranks stay contiguous (PR #3751 R1)", () => {
    const parsed = parseWorkPackageBriefing(
      "Origin: groomed\n\n## Members\n\n1. mt#1 — first\n2. mt#2 — second\n3. mt#1 — again\n4. mt#3\n"
    );
    expect(parsed.members).toEqual([
      { taskId: "mt#1", rank: 1, rationale: "first" },
      { taskId: "mt#2", rank: 2, rationale: "second" },
      { taskId: "mt#3", rank: 3, rationale: null },
    ]);
  });
});

describe("renderMembersSection", () => {
  test("round-trips through parseWorkPackageBriefing with rank and rationale", () => {
    const section = renderMembersSection([
      { taskId: "mt#7", rationale: "first: unblocks the rest" },
      { taskId: "mt#8", rationale: null },
      { taskId: "mt#9", rationale: "  multi\nline  " },
    ]);
    expect(section.split("\n")[0]).toBe(MEMBERS_HEADING);
    const parsed = parseWorkPackageBriefing(`Origin: groomed\n\n${section}\n`);
    expect(parsed.members).toEqual([
      { taskId: "mt#7", rank: 1, rationale: "first: unblocks the rest" },
      { taskId: "mt#8", rank: 2, rationale: null },
      { taskId: "mt#9", rank: 3, rationale: "multi line" },
    ]);
  });
});

describe("upsertBriefingSection", () => {
  const section = `${TRANSFERS_HEADING}\n\n- #1 groomed — t — by x`;

  test("appends the section when the briefing has none, separated by a blank line", () => {
    const out = upsertBriefingSection("Origin: succession\n\n## Situation\n\nfine\n", section);
    expect(out).toBe(`Origin: succession\n\n## Situation\n\nfine\n\n${section}\n`);
  });

  test("replaces an existing section in the middle without touching its neighbours", () => {
    const spec = [
      "Origin: succession",
      "",
      "## Situation",
      "",
      "fine",
      "",
      "## transfers",
      "",
      "- stale line",
      "- another stale line",
      "",
      "## Members",
      "",
      "- mt#1",
      "",
    ].join("\n");
    const out = upsertBriefingSection(spec, section);
    expect(out).toBe(
      `Origin: succession\n\n## Situation\n\nfine\n\n${section}\n\n## Members\n\n- mt#1\n`
    );
    expect(out.match(/## [Tt]ransfers/g)).toHaveLength(1);
  });

  test("replaces an existing section at the end of the briefing", () => {
    const spec = `## Situation\n\nfine\n\n${TRANSFERS_HEADING}\n\n- old\n`;
    expect(upsertBriefingSection(spec, section)).toBe(`## Situation\n\nfine\n\n${section}\n`);
  });

  test("an empty briefing becomes just the section", () => {
    expect(upsertBriefingSection("", section)).toBe(`${section}\n`);
  });

  test("a deeper heading that merely mentions the word is not the section", () => {
    const spec = "## Situation\n\n### Transfers of ownership were manual\n\ntext\n";
    const out = upsertBriefingSection(spec, section);
    expect(out.startsWith(spec.trimEnd())).toBe(true);
    expect(out.endsWith(`${section}\n`)).toBe(true);
  });
});
