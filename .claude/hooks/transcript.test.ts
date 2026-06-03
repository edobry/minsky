import { describe, expect, test } from "bun:test";
import {
  isRealUserPrompt,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  extractLastUserMessage,
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

  test("empty string content is NOT a real prompt", () => {
    expect(isRealUserPrompt(userPrompt("   "))).toBe(false);
  });

  test("assistant line is NOT a user prompt", () => {
    expect(isRealUserPrompt(assistantText("hi"))).toBe(false);
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
