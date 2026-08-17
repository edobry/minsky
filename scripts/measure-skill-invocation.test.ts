// Shape coverage for the skill-invocation counter (mt#4191, PR #3052 R1).
//
// The reviewer caught the counter reading only ONE of the transcript's line
// shapes. The fix is untestable against the live store — no top-level
// `tool_use` line for a `Skill` call exists in it today, so re-running the
// sweep produced byte-identical counts and proved nothing about the new
// branch. That is exactly the non-discriminating probe mem#704 names, so the
// branches are pinned here against synthetic lines instead.
//
// Each positive case is paired with the negative that makes it discriminating:
// a fixture that matches the shape but names a DIFFERENT skill must not count.
import { describe, test, expect } from "bun:test";

import { invocationDates } from "./measure-skill-invocation";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

const TS = "2026-08-16T22:30:00.000Z";
const SKILL = "check-premise";

/** Shape 1: a top-level `tool_use` line — the shape R1 found missing. */
function topLevelCall(skill: string, key: "name" | "tool_name" = "name"): TranscriptLine {
  return { type: "tool_use", [key]: "Skill", input: { skill }, timestamp: TS } as TranscriptLine;
}

/** Shape 2: a `tool_use` block nested in an assistant message. */
function nestedCall(skill: string): TranscriptLine {
  return {
    type: "assistant",
    timestamp: TS,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Skill", input: { skill } }],
    },
  } as TranscriptLine;
}

/** Shape 3: the operator's slash command, as a nested text block. */
function nestedSlash(skill: string): TranscriptLine {
  return {
    type: "user",
    timestamp: TS,
    message: {
      role: "user",
      content: [{ type: "text", text: `<command-name>/${skill}</command-name>` }],
    },
  } as TranscriptLine;
}

/** Shape 4: the operator's slash command, as string content. */
function stringSlash(skill: string): TranscriptLine {
  return {
    type: "user",
    timestamp: TS,
    message: { role: "user", content: `<command-name>/${skill}</command-name>` },
  } as TranscriptLine;
}

describe("invocationDates counts every transcript line shape", () => {
  test("shape 1 — top-level tool_use line, `name` field", () => {
    expect(invocationDates([topLevelCall(SKILL)], SKILL)).toEqual([TS]);
  });

  test("shape 1 — top-level tool_use line, `tool_name` field", () => {
    expect(invocationDates([topLevelCall(SKILL, "tool_name")], SKILL)).toEqual([TS]);
  });

  test("shape 2 — nested tool_use block", () => {
    expect(invocationDates([nestedCall(SKILL)], SKILL)).toEqual([TS]);
  });

  test("shape 3 — slash command as a nested text block", () => {
    expect(invocationDates([nestedSlash(SKILL)], SKILL)).toEqual([TS]);
  });

  test("shape 4 — slash command as string content", () => {
    expect(invocationDates([stringSlash(SKILL)], SKILL)).toEqual([TS]);
  });

  test("all four shapes together count four times", () => {
    const lines = [topLevelCall(SKILL), nestedCall(SKILL), nestedSlash(SKILL), stringSlash(SKILL)];
    expect(invocationDates(lines, SKILL)).toHaveLength(4);
  });
});

describe("the count discriminates — matching the shape is not enough", () => {
  // Without these, every assertion above would still pass on a function that
  // returned a date for any line at all.
  test("a different skill in the same shape does not count", () => {
    const lines = [
      topLevelCall("impeccable"),
      nestedCall("impeccable"),
      nestedSlash("impeccable"),
      stringSlash("impeccable"),
    ];
    expect(invocationDates(lines, SKILL)).toEqual([]);
  });

  test("a prose MENTION of the skill does not count", () => {
    // The whole reason this reads tool calls rather than turn text: 556
    // conversations mention `/check-premise` in prose and none invoked it.
    const prose = {
      type: "assistant",
      timestamp: TS,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `I should have run /${SKILL} before asserting that.` }],
      },
    } as TranscriptLine;
    expect(invocationDates([prose], SKILL)).toEqual([]);
  });

  test("a harness-synthetic (isMeta) slash echo does not double-count", () => {
    const echo = { ...stringSlash(SKILL), isMeta: true } as TranscriptLine;
    expect(invocationDates([echo], SKILL)).toEqual([]);
  });

  test("a line with no timestamp is skipped rather than counted undated", () => {
    const undated = { type: "tool_use", name: "Skill", input: { skill: SKILL } } as TranscriptLine;
    expect(invocationDates([undated], SKILL)).toEqual([]);
  });

  test("a non-Skill tool call does not count", () => {
    const other = {
      type: "tool_use",
      name: "Read",
      input: { skill: SKILL },
      timestamp: TS,
    } as TranscriptLine;
    expect(invocationDates([other], SKILL)).toEqual([]);
  });
});
