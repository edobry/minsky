/**
 * Unowned-finding scan (mt#4246).
 *
 * The rule under test: a spec going DONE should not carry a findings-section
 * item that names neither a task reference nor an explicit no-owner marker.
 *
 * The three originating items are fixtures rather than prose — the two that were
 * left unactioned must fire, and the one that DID name a task must not. That
 * pair is what makes the suite discriminating rather than merely descriptive.
 */
import { describe, test, expect } from "bun:test";
import {
  decideFindings,
  detectUnownedFindings,
  isDischargeRecord,
  isFindingSection,
  resolveNewStatus,
  TARGET_TOOL_NAME,
  TRIGGER_STATUS,
} from "./unowned-finding-scan";
import type { ToolHookInput } from "./types";

function spec(body: string): string {
  return `## Summary\n\nA task.\n\n${body}\n`;
}

function statusSetInput(taskId: string, status: string): ToolHookInput {
  return {
    tool_name: TARGET_TOOL_NAME,
    tool_input: { taskId, status },
  } as unknown as ToolHookInput;
}

/** The two findings-section headings the corpus actually uses. */
const SECTION_NOTICED = "Noticed, not actioned";
const SECTION_THIRD_GUARD = "The third guard, recorded not fixed";
const HEADING_NOTICED = `### ${SECTION_NOTICED}`;
const HEADING_THIRD_GUARD = `## ${SECTION_THIRD_GUARD}`;

describe("isFindingSection", () => {
  test("matches every heading variant the spec enumerates", () => {
    for (const title of [
      "Noticed, not actioned",
      "Not actioned",
      "Noticed but not fixed",
      "Recorded, not fixed",
      "The third guard, recorded not fixed",
      "Out of scope but worth doing",
    ]) {
      expect(isFindingSection(title)).toBe(true);
    }
  });

  test("does NOT match an ordinary section", () => {
    for (const title of ["Summary", "Success Criteria", "Outcome", "Context", "Scope"]) {
      expect(isFindingSection(title)).toBe(false);
    }
  });

  test("a DISCHARGE record is not owed work — the over-match's precise read", () => {
    // The pattern is loose on purpose; this is where the precision lives.
    // `## Required actions resolved (2026-08-16)` records work already done.
    expect(isDischargeRecord("Required actions resolved (2026-08-16)")).toBe(true);
    expect(isFindingSection("Noticed, not actioned — all resolved 2026-08-18")).toBe(false);
    expect(isFindingSection("Recorded, not fixed — discharged in mt#1")).toBe(false);
  });
});

describe("detectUnownedFindings", () => {
  test("the owner marker owns an item; a bare reference does not", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- SC3 is now unblocked and unowned. [owner: mt#4238]",
          "- SC4 is unblocked too — filed as mt#4238.",
        ].join("\n")
      )
    );

    // The second item reads, to a human, exactly like the first. It is the
    // shape the reference test used to discharge, and the whole corpus turned
    // out to be made of it — so only the DECLARED owner counts.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.section).toBe(SECTION_NOTICED);
    expect(findings[0]?.item).toContain("SC4");
  });

  test("a bare reference is RECORDED on the finding, never used to suppress it", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- mt#3130's build list is stale.",
          "- Something with no reference at all.",
        ].join("\n")
      )
    );

    expect(findings.map((f) => f.bareRefPresent)).toEqual([true, false]);
  });

  test("a reference in SUBJECT position fires — the miss the marker closes", () => {
    // The regression this guard's second draft exists to prevent. An earlier
    // draft discharged on any reference, which made "mt#3130's build list is
    // stale" (the task is what is WRONG) indistinguishable from "filed as
    // mt#4238" (the task is what will FIX it). That draft missed 4 of the 4
    // findings items in the corpus, both originating items among them.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- mt#3130's build list still names turn-card grouping as pending.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toContain("build list");
    expect(findings[0]?.bareRefPresent).toBe(true);
  });

  test("the explicit no-owner marker owns an item", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- The lint exemption is now dead. [no-owner: one-line cleanup for whoever touches that list next]",
        ].join("\n")
      )
    );

    expect(findings).toEqual([]);
  });

  test("an EMPTY marker does not own an item — a reason must be stated", () => {
    const findings = detectUnownedFindings(
      spec([HEADING_NOTICED, "", "- Something. [no-owner: ]"].join("\n"))
    );

    expect(findings).toHaveLength(1);
  });

  test("a marker on a wrapped continuation line still counts", () => {
    // Items in this repo's specs routinely wrap; folding continuations in is
    // what keeps the check from firing on its own formatting.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- A long finding whose owner declaration does not fit on the first",
          "  line at all, and lands here instead. [owner: mt#9999]",
        ].join("\n")
      )
    );

    expect(findings).toEqual([]);
  });

  test("only items INSIDE a findings section are considered", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- An unowned finding.",
          "",
          "## Outcome",
          "",
          "- An ordinary bullet with no task ref, in an ordinary section.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toBe("An unowned finding.");
  });

  test("a deeper heading does not close the section, a same-level one does", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- First unowned item.",
          "",
          "#### A sub-heading inside the section",
          "",
          "- Second unowned item.",
          "",
          "### Context",
          "",
          "- Not a finding.",
        ].join("\n")
      )
    );

    expect(findings.map((f) => f.item)).toEqual(["First unowned item.", "Second unowned item."]);
  });

  test("a spec with no findings section yields nothing", () => {
    expect(detectUnownedFindings(spec("## Outcome\n\n- Shipped it."))).toEqual([]);
  });

  test("every findings item in the real corpus fires (mt#4246)", () => {
    // Verbatim from the ONLY three specs in the 4,146-spec corpus that carry a
    // findings section, found by exhaustive scan rather than by recall:
    // mt#3845 (2 items), mt#4220 (2 items), mt#4228 (1 item).
    //
    // All five fire, and that is the correct result rather than an over-fire.
    // Every one of them carries a reference in SUBJECT position and none
    // declares an owner, so a reader of any of these records cannot tell who
    // holds the item. mt#3845's first item is the sharpest case: it WAS actioned
    // (mt#4238 was filed for it) and its text still says only "it needs a
    // follow-up task filed" — the record is ownerless as written, which is the
    // defect this guard is named for.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- **SC3 is now unblocked and unowned.** mt#3847 (its dependency) is DONE. SC3 is",
          "  carved out of this pass only because it lands in `ConversationElementRenderers.tsx`,",
          "  which PR #3078 is modifying. It needs a follow-up task filed once #3078 merges —",
          "  this task's record should not be where it lives.",
          '- **mt#3130\'s build list still names "turn-card grouping FIRST" as pending**, and',
          "  mt#3261 retired it as already-existing. Worth a correction pass on mt#3130 by",
          "  whoever next touches it.",
          "",
          "## Outcome",
          "",
          HEADING_NOTICED,
          "",
          "- **`ConversationView.tsx`'s raw-palette lint exemption is now dead.** That code",
          "  moved out in mt#3262 and the file today contains zero raw palette classes. The",
          "  entry is a latent hole. Left in place rather than removed as out of scope — a",
          "  one-line lint-config cleanup for whoever touches that list next.",
          "- **One `ASSISTANT` header + timestamp per tool call remains.** That is turn",
          "  SEGMENTATION, owned by mt#3130's turn-card grouping and consumed by mt#3845 SC1.",
          "",
          HEADING_THIRD_GUARD,
          "",
          "- The phrase-keyed guard is blind to agentless modals. Measure first; file",
          "  separately if the measurement justifies it.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(5);
    expect(findings.map((f) => f.section)).toEqual([
      SECTION_NOTICED,
      SECTION_NOTICED,
      SECTION_NOTICED,
      SECTION_NOTICED,
      SECTION_THIRD_GUARD,
    ]);
    // Four of five carry a bare reference — which is precisely why a reference
    // could not be the ownership test.
    expect(findings.filter((f) => f.bareRefPresent)).toHaveLength(4);
  });

  test("the same corpus items, once their owners are declared, fall silent", () => {
    // The other half of the fixture above: the marker is reachable, and the
    // adoption cost is one bracketed clause per item.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- **SC3 is now unblocked and unowned.** mt#3847 (its dependency) is DONE.",
          "  [owner: mt#4238]",
          "- **`ConversationView.tsx`'s raw-palette lint exemption is now dead.** The entry",
          "  is a latent hole. [no-owner: one-line lint-config cleanup, no task warranted]",
        ].join("\n")
      )
    );

    expect(findings).toEqual([]);
  });
});

describe("detectUnownedFindings — prose-bodied sections", () => {
  test("a findings section with no list items counts as one finding", () => {
    // mt#4228's real shape: a named findings heading, several paragraphs, an
    // undischarged conditional, and no bullet anywhere.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_THIRD_GUARD,
          "",
          "`turn-end-untaken-action-scan` was also blind, for an unrelated reason.",
          "Its patterns key on first-person commitment; the closing line was an",
          "agentless modal.",
          "",
          "Not fixed here on purpose. File separately if the measurement justifies it.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.section).toBe(SECTION_THIRD_GUARD);
    expect(findings[0]?.item).toContain("File separately");
  });

  test("a prose section declaring an owner anywhere in its body is silent", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_THIRD_GUARD,
          "",
          "The phrase-keyed guard is blind to agentless modals. [owner: mt#3831]",
        ].join("\n")
      )
    );

    expect(findings).toEqual([]);
  });

  test("a fenced block cannot open a section, and its content is not the finding", () => {
    // The `#` lines inside a fence are output, not headings — and mt#4228's real
    // section carries exactly such a block.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_THIRD_GUARD,
          "",
          "Verified by running the shipped detector against both strings:",
          "",
          "```",
          HEADING_NOTICED,
          'KNOWN-POSITIVE: [{"family":"going-to"}]',
          "```",
          "",
          "Not fixed here on purpose.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).not.toContain("KNOWN-POSITIVE");
    expect(findings[0]?.item).toContain("Not fixed here on purpose");
  });

  test("a section with list items ignores its own preamble prose", () => {
    // Guards against double-counting: once a bullet appears, the paragraph
    // above it is context for the list, not a separate finding.
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "Two things surfaced during this pass and neither is in scope.",
          "",
          "- The first one.",
          "- The second one.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.item)).toEqual(["The first one.", "The second one."]);
  });

  test("an EMPTY findings section yields nothing", () => {
    expect(detectUnownedFindings(spec("### Noticed, not actioned\n\n## Next\n\nBody."))).toEqual(
      []
    );
  });
});

describe("a deeper subheading does not split a prose section (PR #3098 R2)", () => {
  test("three subheadings inside one findings section still yield ONE item", () => {
    // `closeSection()` is what records a prose-bodied section, and it used to
    // run on EVERY heading while a section was open — so each subheading
    // emitted the prose above it and reset. One finding became three.
    const findings = detectUnownedFindings(
      spec(
        [
          "## The third guard, recorded not fixed",
          "",
          "The phrase-keyed guard is blind to agentless modals.",
          "",
          "#### What was measured",
          "",
          "Ran the shipped detector against both strings.",
          "",
          "#### Why it is not fixed here",
          "",
          "Widening a phrase guard is the arms race ADR-024 ends.",
          "",
          "#### What would fix it",
          "",
          "File separately if the measurement justifies it.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toContain("blind to agentless modals");
    expect(findings[0]?.item).toContain("File separately");
  });

  test("a same-level heading DOES close the section — the boundary still works", () => {
    // The other half: over-correcting into "never close on a heading" would
    // run one section into the next and swallow the boundary entirely.
    const findings = detectUnownedFindings(
      spec(
        [
          "## The third guard, recorded not fixed",
          "",
          "An unowned prose finding.",
          "",
          "## Context",
          "",
          "Ordinary prose that is not a finding at all.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toContain("An unowned prose finding");
    expect(findings[0]?.item).not.toContain("Ordinary prose");
  });

  test("a subheading still ends the open list item", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "- First item, unowned.",
          "",
          "#### A subheading",
          "",
          "- Second item, unowned.",
        ].join("\n")
      )
    );

    expect(findings.map((f) => f.item)).toEqual(["First item, unowned.", "Second item, unowned."]);
  });
});

describe("fence tracking is document-scoped, not section-scoped (PR #3098 R1)", () => {
  test("a findings heading inside a fence OUTSIDE any section does not open one", () => {
    // The BLOCKING regression. Fence tracking used to toggle only while a
    // section was already open, so a fence in ordinary prose never set the
    // flag and the heading inside it was read as real. Specs quoting this
    // guard's own trigger — mt#4246's, mt#4228's, this PR's body — are exactly
    // that shape, so the guard would have fired on its own documentation.
    const findings = detectUnownedFindings(
      spec(
        [
          "## Summary",
          "",
          "The guard keys on a heading like this:",
          "",
          "```markdown",
          HEADING_NOTICED,
          "",
          "- An item with no owner at all.",
          "```",
          "",
          "That is the whole trigger.",
        ].join("\n")
      )
    );

    expect(findings).toEqual([]);
  });

  test("a REAL section after a closed fence is still detected — parity is not broken", () => {
    // The other half: over-correcting (e.g. never clearing the flag, or
    // clearing it at a section boundary) would swallow every section following
    // a code block. Most real specs have one.
    const findings = detectUnownedFindings(
      spec(
        [
          "## Summary",
          "",
          "```ts",
          "const x = 1;",
          "```",
          "",
          HEADING_NOTICED,
          "",
          "- A genuinely unowned item.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toContain("genuinely unowned");
  });

  test("a fence inside a section still hides its contents, and the section survives it", () => {
    const findings = detectUnownedFindings(
      spec(
        [
          HEADING_NOTICED,
          "",
          "```",
          "## Not a heading",
          "- Not an item.",
          "```",
          "",
          "- A real item with no owner.",
        ].join("\n")
      )
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toContain("A real item");
  });
});

describe("decideFindings", () => {
  const readSpec = () => spec([HEADING_NOTICED, "", "- An unowned finding."].join("\n"));

  test("fires on a transition to DONE", () => {
    expect(decideFindings(statusSetInput("mt#1", "DONE"), { readSpec })).toHaveLength(1);
  });

  test("does NOT fire on any other status", () => {
    for (const status of ["TODO", "PLANNING", "READY", "IN-PROGRESS", "IN-REVIEW", "BLOCKED"]) {
      expect(decideFindings(statusSetInput("mt#1", status), { readSpec })).toEqual([]);
    }
  });

  test("does NOT fire on a different tool", () => {
    const other = {
      tool_name: "mcp__minsky__tasks_spec_patch",
      tool_input: { taskId: "mt#1", status: "DONE" },
    } as unknown as ToolHookInput;
    expect(decideFindings(other, { readSpec })).toEqual([]);
  });

  test("FAILS OPEN when the spec cannot be read", () => {
    // An unreadable spec records nothing rather than guessing — the same
    // direction every other predicate in this guard fails.
    expect(decideFindings(statusSetInput("mt#1", "DONE"), { readSpec: () => null })).toEqual([]);
  });

  test("status is read case-insensitively, and from the response when absent from input", () => {
    expect(decideFindings(statusSetInput("mt#1", "done"), { readSpec })).toHaveLength(1);

    const fromResponse = {
      tool_name: TARGET_TOOL_NAME,
      tool_input: { taskId: "mt#1" },
      tool_response: { newStatus: TRIGGER_STATUS },
    } as unknown as ToolHookInput;
    expect(resolveNewStatus(fromResponse)).toBe(TRIGGER_STATUS);
    expect(decideFindings(fromResponse, { readSpec })).toHaveLength(1);
  });
});
