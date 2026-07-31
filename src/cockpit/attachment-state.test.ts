/**
 * Tests for the row attachment-state categorization (mt#2286).
 */
import { describe, test, expect } from "bun:test";
import {
  deriveRowAttachState,
  groupAttachmentsBySessionId,
  type AttachStateInput,
} from "./attachment-state";

function attachment(overrides: Partial<AttachStateInput> = {}): AttachStateInput {
  return {
    sessionId: overrides.sessionId ?? "session-x",
    terminalContext: overrides.terminalContext,
  };
}

describe("deriveRowAttachState", () => {
  test("returns 'detached' for an empty attachment list", () => {
    expect(deriveRowAttachState([])).toBe("detached");
  });

  test("returns 'attached-external' when a live attachment carries terminalContext", () => {
    const result = deriveRowAttachState([
      attachment({ terminalContext: { TERM_PROGRAM: "tmux" } }),
    ]);
    expect(result).toBe("attached-external");
  });

  test("returns 'in-cockpit' when a live attachment exists but terminalContext is empty", () => {
    const result = deriveRowAttachState([attachment({ terminalContext: {} })]);
    expect(result).toBe("in-cockpit");
  });

  test("returns 'in-cockpit' when terminalContext is undefined", () => {
    const result = deriveRowAttachState([attachment({ terminalContext: undefined })]);
    expect(result).toBe("in-cockpit");
  });

  test("returns 'attached-external' when ANY of several attachments carries terminalContext", () => {
    const result = deriveRowAttachState([
      attachment({ terminalContext: {} }),
      attachment({ terminalContext: { TMUX_PANE: "%3" } }),
    ]);
    expect(result).toBe("attached-external");
  });
});

describe("groupAttachmentsBySessionId", () => {
  test("groups a flat list by sessionId", () => {
    const grouped = groupAttachmentsBySessionId([
      attachment({ sessionId: "s1" }),
      attachment({ sessionId: "s2" }),
      attachment({ sessionId: "s1" }),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("s1")).toHaveLength(2);
    expect(grouped.get("s2")).toHaveLength(1);
  });

  test("returns an empty map for an empty input", () => {
    expect(groupAttachmentsBySessionId([]).size).toBe(0);
  });

  test("a session with no attachments is simply absent from the map (not an empty array entry)", () => {
    const grouped = groupAttachmentsBySessionId([attachment({ sessionId: "s1" })]);
    expect(grouped.get("s2")).toBeUndefined();
  });
});
