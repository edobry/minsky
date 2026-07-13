/**
 * Tests for `hook-preamble-matcher` (mt#2022).
 *
 * The matcher resolves Claude Code `hook_additional_context` attachments to
 * specific hook script names by content-preamble matching. These tests pin
 * the rule set to the in-tree hook scripts (memory-search,
 * skill-staleness-detector) so future preamble drift is caught early.
 */

import { describe, expect, test } from "bun:test";
import {
  extractAttachmentContentString,
  HOOK_PREAMBLE_RULES,
  matchHookScript,
} from "./hook-preamble-matcher";

const USER_PROMPT_SUBMIT_EVENT = "UserPromptSubmit";

describe("matchHookScript — preamble routing (mt#2022)", () => {
  test("memory-search.ts: matches the canonical injection preamble", () => {
    const memoryContent =
      "<system-reminder>\nThe following memory records may be relevant to your task. " +
      "They were retrieved from your persistent memory store via on-demand search; " +
      "treat them as durable project memory entries. Do not mention this reminder to the user.\n\n" +
      "### Some memory record\nbody…";
    expect(matchHookScript(USER_PROMPT_SUBMIT_EVENT, memoryContent)).toBe("memory-search.ts");
  });

  test("skill-staleness-detector.ts: matches the staleness preamble", () => {
    const stalenessContent =
      "<system-reminder>\nNote: 2 skill/agent/rule files changed since this session started:\n" +
      "  - .claude/skills/retrospective/SKILL.md (modified)\n" +
      "  - .minsky/rules/decision-defaults.mdc (modified)\n</system-reminder>";
    expect(matchHookScript(USER_PROMPT_SUBMIT_EVENT, stalenessContent)).toBe(
      "skill-staleness-detector.ts"
    );
  });

  test("returns null for an unrecognized preamble", () => {
    expect(
      matchHookScript(USER_PROMPT_SUBMIT_EVENT, "Some other injection that doesn't match anything")
    ).toBeNull();
  });

  test("returns null for an unknown hook event", () => {
    // The memory-search preamble would match IF the event matched the rule,
    // but the rule's hookEvent is "UserPromptSubmit" — a different event is a non-match.
    expect(
      matchHookScript("PostToolUse", "The following memory records may be relevant to your task")
    ).toBeNull();
  });

  test("returns null on non-string inputs (defensive)", () => {
    // @ts-expect-error — testing runtime defensive behavior
    expect(matchHookScript(null, "anything")).toBeNull();
    // @ts-expect-error — testing runtime defensive behavior
    expect(matchHookScript(USER_PROMPT_SUBMIT_EVENT, null)).toBeNull();
  });

  test("rule set has at least the two known in-tree hooks", () => {
    const names = HOOK_PREAMBLE_RULES.map((r) => r.scriptName);
    expect(names).toContain("memory-search.ts");
    expect(names).toContain("skill-staleness-detector.ts");
  });
});

describe("extractAttachmentContentString — defensive normalization", () => {
  test("string input returned verbatim", () => {
    expect(extractAttachmentContentString("hello")).toBe("hello");
  });

  test("array of strings joined with newline", () => {
    expect(extractAttachmentContentString(["a", "b", "c"])).toBe("a\nb\nc");
  });

  test("array with non-strings: filters to strings only", () => {
    expect(extractAttachmentContentString(["a", 42, "b", null, "c"])).toBe("a\nb\nc");
  });

  test("unrecognized shapes return empty string", () => {
    expect(extractAttachmentContentString(null)).toBe("");
    expect(extractAttachmentContentString(undefined)).toBe("");
    expect(extractAttachmentContentString({ wat: 1 })).toBe("");
    expect(extractAttachmentContentString(42)).toBe("");
  });
});
