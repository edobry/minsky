/**
 * `## Referenced Memories, Asks & Workspaces` prompt rendering (mt#3964).
 *
 * mt#3919 gave the reviewer a channel for `mt#NNNN` references appearing
 * inside a task spec (see `prompt.test.ts`'s "buildReferencedTaskSpecsSection"
 * block). This file covers the sibling channel for the three ADR-029
 * short-id families that mechanism didn't reach: `mem#N` (memory), `ask#N`
 * (ask), `ws#N` (workspace/session).
 *
 * Lives in its own file rather than appended to `prompt.test.ts`, which is
 * already at the 1500-line `max-lines` cap (see `prompt-doc-impact.test.ts`
 * for the same precedent on a different concern).
 */

import { describe, expect, test } from "bun:test";
import { buildReviewPrompt, type ReviewPromptInput } from "./prompt";

const SAMPLE_DIFF = "diff --git a/foo b/foo";
const TASK_SPECIFICATION_HEADING = "## Task Specification";
const REFERENCED_SHORT_IDS_HEADING = "## Referenced Memories, Asks & Workspaces";
const UNVERIFIABLE_INSTRUCTION = "must be reported `Unverifiable`";

describe("buildReferencedShortIdsSection (mt#3964)", () => {
  const baseInput: ReviewPromptInput = {
    prNumber: 999,
    prTitle: "Test PR",
    prBody: "",
    taskSpec: "## Success Criteria\n\n- [ ] mem#648's CORRECTION 1 is amended.",
    diff: SAMPLE_DIFF,
    authorshipTier: 3,
    branchName: "task/test",
    baseBranch: "main",
  };

  test("omits the section when referencedShortIds is undefined", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).not.toContain(REFERENCED_SHORT_IDS_HEADING);
  });

  test("omits the section when referencedShortIds is an empty array", () => {
    const prompt = buildReviewPrompt({ ...baseInput, referencedShortIds: [] });
    expect(prompt).not.toContain(REFERENCED_SHORT_IDS_HEADING);
  });

  test("positive case: renders fetched memory content under the reference's heading (mt#3729 criterion 4 replay)", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#648",
          kind: "memory",
          content:
            "CORRECTION 1 is amended: the ask-then-grant path stays correct, but is " +
            "no longer the FIRST move for a verified false positive.",
          updatedAt: "2026-08-11T10:00:00.000Z",
          fetchResult: { status: "found", ref: "mem#648" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(prompt).toContain(REFERENCED_SHORT_IDS_HEADING);
    expect(prompt).toContain("### mem#648 (memory) (last updated 2026-08-11T10:00:00.000Z)");
    expect(prompt).toContain("no longer the FIRST move for a verified false positive.");
    // Placed after the primary Task Specification section.
    expect(prompt.indexOf(TASK_SPECIFICATION_HEADING)).toBeLessThan(
      prompt.indexOf(REFERENCED_SHORT_IDS_HEADING)
    );
  });

  test("negative control: an unamended memory renders as different content from the positive case, never a suppression", () => {
    // The criterion text itself (in baseInput.taskSpec) intentionally does NOT
    // repeat either candidate phrase below, so a match can only come from the
    // INJECTED memory content — not from the criterion leaking into both runs.
    const positivePrompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#648",
          kind: "memory",
          content: "POSITIVE-MARKER: the ask-then-grant path is no longer the first move.",
          updatedAt: "2026-08-11T10:00:00.000Z",
          fetchResult: { status: "found", ref: "mem#648" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });
    const negativePrompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#648",
          kind: "memory",
          content: "NEGATIVE-MARKER: the ask-then-grant path remains the first move, unamended.",
          updatedAt: "2026-08-05T10:00:00.000Z",
          fetchResult: { status: "found", ref: "mem#648" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(positivePrompt).toContain("POSITIVE-MARKER");
    expect(negativePrompt).toContain("NEGATIVE-MARKER");
    // The two runs must render DIFFERENT content — a suppression would make
    // them identical regardless of what the memory actually says.
    expect(positivePrompt).not.toBe(negativePrompt);
    expect(negativePrompt).not.toContain("POSITIVE-MARKER");
    expect(positivePrompt).not.toContain("NEGATIVE-MARKER");
  });

  test("renders a resolution-failure entry naming the status for a nonexistent short id, never Met", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#999999",
          kind: "memory",
          content: null,
          updatedAt: null,
          fetchResult: { status: "not-found", ref: "mem#999999" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(prompt).toContain("### mem#999999 (memory) — could not be resolved");
    expect(prompt).toContain("Fetch status: `not-found`");
    expect(prompt).toContain(UNVERIFIABLE_INSTRUCTION);
  });

  test("renders an ambiguous ws#N resolution distinctly from a plain not-found", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "ws#5",
          kind: "workspace",
          content: null,
          updatedAt: null,
          fetchResult: { status: "ambiguous", ref: "ws#5", error: "Ambiguous workspace id" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(prompt).toContain("### ws#5 (workspace/session) — could not be resolved");
    expect(prompt).toContain("Fetch status: `ambiguous`");
  });

  test("renders an ask#N reference under the correct kind label", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "ask#12",
          kind: "ask",
          content: "**Question:** should we ship this?\n\n**State:** closed",
          updatedAt: "2026-08-11T09:00:00.000Z",
          fetchResult: { status: "found", ref: "ask#12" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(prompt).toContain("### ask#12 (ask) (last updated 2026-08-11T09:00:00.000Z)");
    expect(prompt).toContain("should we ship this?");
  });

  test("instructs the model not to escalate Unverifiable to a BLOCKING finding", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#999999",
          kind: "memory",
          content: null,
          updatedAt: null,
          fetchResult: { status: "disabled", ref: "mem#999999" },
          truncated: false,
          omittedChars: 0,
        },
      ],
    });

    expect(prompt).toContain("Do NOT also emit a `submit_finding` with severity BLOCKING");
  });

  test("truncated content over the per-reference cap renders TRUNCATED + Unverifiable instruction, never Not Met", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "mem#648",
          kind: "memory",
          content: "partial memory content shown here",
          updatedAt: "2026-08-11T10:00:00.000Z",
          fetchResult: { status: "found", ref: "mem#648" },
          truncated: true,
          omittedChars: 8_000,
        },
      ],
    });

    expect(prompt).toContain("⚠️ TRUNCATED");
    expect(prompt).toContain("8000 additional char(s)");
    expect(prompt).toContain("report `Unverifiable`, not `Not Met`");
    expect(prompt).toContain("partial memory content shown here");
  });

  test("renders a distinct context-budget-omitted block, never confused with a resolution failure", () => {
    const prompt = buildReviewPrompt({
      ...baseInput,
      referencedShortIds: [
        {
          ref: "ws#7",
          kind: "workspace",
          content: null,
          updatedAt: null,
          fetchResult: { status: "found", ref: "ws#7" },
          truncated: true,
          omittedChars: 4_000,
        },
      ],
    });

    expect(prompt).toContain("### ws#7 (workspace/session) — omitted (context budget)");
    expect(prompt).toContain("fetched successfully");
    expect(prompt).toContain(UNVERIFIABLE_INSTRUCTION);
    expect(prompt).not.toContain("ws#7 (workspace/session) — could not be resolved");
  });
});
