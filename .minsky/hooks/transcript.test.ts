import { describe, expect, test } from "bun:test";
import {
  isRealUserPrompt,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  extractLastUserMessage,
  findRealPromptIndices,
  type TranscriptLine,
} from "./transcript";

// ---------------------------------------------------------------------------
// Transcript line builders (mirror the real Claude Code JSONL shapes)
// ---------------------------------------------------------------------------

const userPrompt = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: text },
});

const userPromptTextArray = (text: string): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});

const toolResult = (id = "t1"): TranscriptLine => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

const assistantText = (text: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantToolUse = (name: string): TranscriptLine => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
});

/**
 * Claude Code's harness-synthesized "the user cancelled this tool call"
 * marker — recorded with `role: "user"` and a single `{ type: "text" }`
 * block, matching the REAL shape observed in the two mt#2824 originating
 * incident transcripts (a9c1a09b, ac4f5675).
 */
const interruptMarker = (variant: "tool use" | "bare" = "tool use"): TranscriptLine => ({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text:
          variant === "tool use"
            ? "[Request interrupted by user for tool use]"
            : "[Request interrupted by user]",
      },
    ],
  },
});

/**
 * The same synthetic interrupt marker, but as a bare STRING `message.content`
 * rather than an array-of-text-blocks — the content shape NOT observed in
 * the two originating transcripts, but which the PR #1963 R2 review flagged
 * as uncovered by the original fix (which only excluded the array shape and
 * asserted, without defensive justification, that the string shape was
 * safe). Uses `userPrompt`'s exact content shape (`message.content` is a
 * plain string) with the marker text as the string value.
 */
const interruptMarkerString = (variant: "tool use" | "bare" = "tool use"): TranscriptLine =>
  userPrompt(
    variant === "tool use"
      ? "[Request interrupted by user for tool use]"
      : "[Request interrupted by user]"
  );

// ---------------------------------------------------------------------------
// isRealUserPrompt — the text-content discriminator
// ---------------------------------------------------------------------------

describe("isRealUserPrompt", () => {
  test("string content is a real prompt", () => {
    expect(isRealUserPrompt(userPrompt("do X"))).toBe(true);
  });

  test("text-block content array is a real prompt", () => {
    expect(isRealUserPrompt(userPromptTextArray("do X"))).toBe(true);
  });

  test("tool_result content array is NOT a real prompt", () => {
    expect(isRealUserPrompt(toolResult())).toBe(false);
  });

  test("whitespace-only string content IS a real prompt (string is never a tool_result)", () => {
    // A string-content user line is always human input — tool_result lines are
    // always content arrays — so it still resets the turn boundary (mt#2255 review).
    expect(isRealUserPrompt(userPrompt("   "))).toBe(true);
  });

  test("assistant line is NOT a user prompt", () => {
    expect(isRealUserPrompt(assistantText("hi"))).toBe(false);
  });

  // mt#2824: discovered while replaying the two originating silent-stretch
  // incident transcripts — this exact harness marker landed ~20ms before the
  // operator's real interrupt message in BOTH, and was originally
  // misclassified as a real prompt boundary, collapsing the measured turn
  // down to those 20ms and hiding the actual ~24/28-minute silent stretch.
  test("'[Request interrupted by user for tool use]' marker is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarker("tool use"))).toBe(false);
  });

  test("'[Request interrupted by user]' marker is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarker("bare"))).toBe(false);
  });

  // PR #1963 R2 (2026-07-15): the original fix excluded the marker only in
  // its array-of-text-blocks content shape (the shape actually observed in
  // the two originating transcripts) and asserted the STRING content shape
  // needed no check because the marker "hadn't been observed there." That
  // reasoning doesn't hold — the array shape's exact form was itself a
  // surprise, so "not yet observed" in the string shape is not evidence the
  // string shape is safe. Both shapes must exclude the marker identically.
  test("'[Request interrupted by user for tool use]' marker as STRING content is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarkerString("tool use"))).toBe(false);
  });

  test("'[Request interrupted by user]' marker as STRING content is NOT a real prompt", () => {
    expect(isRealUserPrompt(interruptMarkerString("bare"))).toBe(false);
  });

  test("marker text with surrounding whitespace is still excluded (both shapes trim before comparing)", () => {
    expect(isRealUserPrompt(userPrompt("  [Request interrupted by user]  "))).toBe(false);
    expect(
      isRealUserPrompt(userPromptTextArray("  [Request interrupted by user for tool use]  "))
    ).toBe(false);
  });

  test("marker text is NOT excluded when it's a substring of otherwise-real human text (either shape)", () => {
    // A human quoting or referencing the marker phrase inside a real message
    // must not be misclassified as the synthetic marker itself — only an
    // EXACT (trimmed) match is excluded.
    expect(isRealUserPrompt(userPrompt("why did [Request interrupted by user] show up?"))).toBe(
      true
    );
    expect(
      isRealUserPrompt(
        userPromptTextArray("why did [Request interrupted by user for tool use] show up?")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractLastAssistantTurn — must NOT split on tool_result lines
// ---------------------------------------------------------------------------

describe("extractLastAssistantTurn — multi-round turn (tool_result split)", () => {
  test("spans the full logical turn across interleaved tool_result lines", () => {
    // A turn that makes a tool call: the trailing assistant segment sits AFTER
    // a tool_result, which a naive user-role split would treat as the boundary.
    const lines: TranscriptLine[] = [
      userPrompt("create the PR"),
      assistantText("calling create"),
      assistantToolUse("session_pr_create"),
      toolResult(),
      assistantText("PR created #5"),
      userPrompt("what's next?"), // current prompt — excluded
    ];

    const turn = extractLastAssistantTurn(lines);

    // The whole span between the two real prompts is returned — both assistant
    // segments AND the tool_result line, not just the trailing segment.
    expect(turn.length).toBe(4);
    const text = extractAssistantText(turn);
    expect(text).toContain("calling create");
    expect(text).toContain("PR created #5");
    expect(extractToolUseNames(turn)).toContain("session_pr_create");
  });

  test("tool_result lines do not start a new turn (real-prompt boundary)", () => {
    // Two real prompts with several tool rounds in the first turn. The naive
    // implementation would bound the turn at the LAST tool_result, dropping the
    // earlier assistant segment + tool call.
    const lines: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("step one"),
      assistantToolUse("Bash"),
      toolResult("a"),
      assistantText("step two"),
      assistantToolUse("Edit"),
      toolResult("b"),
      assistantText("done"),
      userPrompt("second prompt"),
    ];

    const turn = extractLastAssistantTurn(lines);
    const names = extractToolUseNames(turn);
    expect(names).toContain("Bash");
    expect(names).toContain("Edit");
    expect(extractAssistantText(turn)).toContain("step one");
  });

  test("real prompt expressed as a text-block array still bounds the turn", () => {
    const lines: TranscriptLine[] = [
      userPromptTextArray("first"),
      assistantText("work"),
      toolResult(),
      assistantText("more work"),
      userPromptTextArray("second"),
    ];
    const turn = extractLastAssistantTurn(lines);
    expect(extractAssistantText(turn)).toContain("work");
    expect(extractAssistantText(turn)).toContain("more work");
  });

  // mt#2824: a synthetic "[Request interrupted...]" marker must NOT act as a
  // turn boundary — the turn must span across it up to the NEXT real human
  // prompt, so a silent-stretch measurement over the turn sees the full
  // silence window rather than just the few milliseconds after the marker.
  test("synthetic interrupt marker does not split the turn early", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first prompt"),
      assistantText("step one"),
      assistantToolUse("Bash"),
      toolResult("a"),
      interruptMarker("tool use"),
      userPrompt("why so quiet? did the harness break?"), // real interrupt, current prompt
    ];

    const turn = extractLastAssistantTurn(lines);

    // The turn spans from AFTER "first prompt" through the interrupt marker
    // (inclusive of it, since it's not a boundary) up to (exclusive of) the
    // real interrupt prompt — 4 lines: step-one text, tool_use, tool_result,
    // interrupt marker.
    expect(turn.length).toBe(4);
    expect(extractAssistantText(turn)).toContain("step one");
    expect(extractToolUseNames(turn)).toContain("Bash");
  });

  test("returns [] with fewer than 2 real prompts (tool_results do not count)", () => {
    const lines: TranscriptLine[] = [
      userPrompt("only prompt"),
      assistantText("work"),
      toolResult(),
      assistantText("more"),
    ];
    expect(extractLastAssistantTurn(lines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractLastUserMessage — skips trailing tool_result lines
// ---------------------------------------------------------------------------

describe("extractLastUserMessage", () => {
  test("returns the most-recent real prompt, not a trailing tool_result", () => {
    const lines: TranscriptLine[] = [
      userPrompt("earlier"),
      assistantText("work"),
      userPrompt("the real current prompt"),
      assistantToolUse("Bash"),
      toolResult(),
    ];
    expect(extractLastUserMessage(lines)).toBe("the real current prompt");
  });

  test("returns '' when no real prompt exists", () => {
    expect(extractLastUserMessage([toolResult(), assistantText("x")])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// findRealPromptIndices — the raw index list extractLastAssistantTurn slices
// between (mt#2824: factored out so callers can read the boundary LINES'
// own fields, e.g. timestamps, not just the slice between them)
// ---------------------------------------------------------------------------

describe("findRealPromptIndices", () => {
  test("returns indices of real prompts only, skipping tool_result/assistant lines", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first"), // 0
      assistantToolUse("Read"), // 1
      toolResult(), // 2
      assistantText("done"), // 3
      userPrompt("second"), // 4
    ];
    expect(findRealPromptIndices(lines)).toEqual([0, 4]);
  });

  test("returns [] when there are no real prompts", () => {
    expect(findRealPromptIndices([toolResult(), assistantText("x")])).toEqual([]);
  });

  test("extractLastAssistantTurn's boundaries match findRealPromptIndices' last two entries", () => {
    const lines: TranscriptLine[] = [
      userPrompt("first"),
      assistantToolUse("Read"),
      toolResult(),
      userPrompt("second"),
    ];
    const indices = findRealPromptIndices(lines);
    expect(indices).toEqual([0, 3]);
    const turn = extractLastAssistantTurn(lines);
    expect(turn).toEqual(lines.slice((indices[0] as number) + 1, indices[1] as number));
  });
});
