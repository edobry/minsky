/**
 * Tests for the conversation-label precedence logic (mt#2770).
 */
import { describe, expect, test } from "bun:test";
import {
  computeConversationLabel,
  composeSubagentDescriptor,
  deriveFallbackLabel,
  type ConversationLabelInputs,
} from "./conversation-label";

const BASE: ConversationLabelInputs = {
  agentSessionId: "8e586448-17b7-43c3-becc-4d75460c9454",
  cwd: "/Users/edobry/Projects/minsky",
  startedAt: new Date("2026-05-20T14:30:00.000Z"),
  linkedTaskTitle: null,
  firstUserText: null,
  subagentDescriptor: null,
};

/** Shared fixture string — extracted to satisfy custom/no-magic-string-duplication. */
const EXPLORE_SUBAGENT_LABEL = "Explore subagent";

describe("computeConversationLabel — precedence", () => {
  test("tier 1: linked task title wins over everything else", () => {
    const label = computeConversationLabel({
      ...BASE,
      linkedTaskTitle: "Conversation labeling: task-binding + first-prompt snippet labels",
      firstUserText: "implement the labeling task",
      subagentDescriptor: EXPLORE_SUBAGENT_LABEL,
    });
    expect(label).toContain("Conversation labeling");
  });

  test("tier 2: first-user-prompt snippet when no task title resolved", () => {
    const label = computeConversationLabel({
      ...BASE,
      firstUserText: "Please investigate why the reviewer bot keeps failing on CI runs",
      subagentDescriptor: EXPLORE_SUBAGENT_LABEL,
    });
    expect(label.startsWith("Please investigate")).toBe(true);
  });

  test("tier 2 strips markdown and truncates to ~60 chars", () => {
    const label = computeConversationLabel({
      ...BASE,
      firstUserText:
        "# Fix the bug\n\nThis is a much longer first prompt that should be truncated to keep list rows readable and scannable.",
    });
    expect(label).not.toContain("#");
    expect(label.length).toBeLessThanOrEqual(61);
  });

  test("tier 3: subagent descriptor when no task title or first-user text resolved", () => {
    const label = computeConversationLabel({
      ...BASE,
      subagentDescriptor: "refactorer — mt#2770: Conversation labeling",
    });
    expect(label).toContain("refactorer");
  });

  test("tier 4: falls back to timestamp·cwd·id when nothing else resolves", () => {
    const label = computeConversationLabel(BASE);
    expect(label).toBe(deriveFallbackLabel(BASE.agentSessionId, BASE.cwd, BASE.startedAt));
  });

  test("empty-string linkedTaskTitle does not block fallthrough to tier 2", () => {
    const label = computeConversationLabel({
      ...BASE,
      linkedTaskTitle: "",
      firstUserText: "a real first prompt",
    });
    expect(label).toBe("a real first prompt");
  });

  test("empty-string subagentDescriptor does not block fallthrough to tier 4", () => {
    const label = computeConversationLabel({
      ...BASE,
      subagentDescriptor: "",
    });
    expect(label).toBe(deriveFallbackLabel(BASE.agentSessionId, BASE.cwd, BASE.startedAt));
  });
});

describe("composeSubagentDescriptor", () => {
  test("prefers invocation agentType + resolved task title", () => {
    const result = composeSubagentDescriptor({
      invocationAgentType: "refactorer",
      invocationTaskId: "mt#2770",
      invocationTaskTitle: "Conversation labeling",
      spawnAgentKind: "Explore",
    });
    expect(result).toBe("refactorer — Conversation labeling");
  });

  test("falls back to bare task id when title unresolved", () => {
    const result = composeSubagentDescriptor({
      invocationAgentType: "refactorer",
      invocationTaskId: "mt#2770",
      invocationTaskTitle: null,
      spawnAgentKind: null,
    });
    expect(result).toBe("refactorer — mt#2770");
  });

  test("falls back to bare agentType when neither task id nor title resolve", () => {
    const result = composeSubagentDescriptor({
      invocationAgentType: "Explore",
      invocationTaskId: null,
      invocationTaskTitle: null,
      spawnAgentKind: null,
    });
    expect(result).toBe(EXPLORE_SUBAGENT_LABEL);
  });

  test("falls back to agent_spawns agentKind when no invocation row resolved", () => {
    const result = composeSubagentDescriptor({
      invocationAgentType: null,
      invocationTaskId: null,
      invocationTaskTitle: null,
      spawnAgentKind: "Explore",
    });
    expect(result).toBe(EXPLORE_SUBAGENT_LABEL);
  });

  test("returns null when nothing resolves", () => {
    const result = composeSubagentDescriptor({
      invocationAgentType: null,
      invocationTaskId: null,
      invocationTaskTitle: null,
      spawnAgentKind: null,
    });
    expect(result).toBeNull();
  });
});

describe("deriveFallbackLabel", () => {
  test("handles null cwd and null startedAt defensively", () => {
    const label = deriveFallbackLabel("abc12345-aaaa-bbbb-cccc-ddddeeeeffff", null, null);
    expect(label).toContain("no-ts");
    expect(label).toContain("unknown");
    expect(label).toContain("abc12345");
  });
});
