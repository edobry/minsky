/**
 * Tests for the "go to" action routing decision (mt#2286).
 *
 * Pure, no React/router dependency — mirrors RunDetail.tabs.test.ts's
 * approach of testing the exported route/path logic directly rather than
 * rendering the component.
 */
import { describe, test, expect } from "bun:test";
import { resolveGoToAction, type AgentRow } from "./Agents";

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    kind: overrides.kind ?? "dispatched-agent",
    title: overrides.title ?? "some-branch",
    liveness: overrides.liveness ?? "healthy",
    taskId: overrides.taskId ?? null,
    taskTitle: overrides.taskTitle ?? null,
    prNumber: overrides.prNumber ?? null,
    prStatus: overrides.prStatus ?? null,
    lastActivityAt: overrides.lastActivityAt ?? new Date().toISOString(),
    agentId: overrides.agentId ?? null,
    conversationId: overrides.conversationId ?? null,
    cwd: overrides.cwd ?? null,
    subagents: overrides.subagents ?? [],
    driven: overrides.driven ?? null,
    attachState: overrides.attachState ?? null,
  };
}

describe("resolveGoToAction — dispatched-agent rows (mt#2284 attachState routing)", () => {
  test("attached-external -> focus action targeting the workspace sessionId", () => {
    const row = makeRow({ sessionId: "ws-1", attachState: "attached-external" });
    expect(resolveGoToAction(row)).toEqual({ type: "focus", sessionId: "ws-1" });
  });

  test("in-cockpit -> navigate to the workspace's Conversation tab", () => {
    const row = makeRow({ sessionId: "ws-1", attachState: "in-cockpit" });
    expect(resolveGoToAction(row)).toEqual({
      type: "navigate",
      path: "/agents/ws-1/conversation",
    });
  });

  test("detached -> disabled with a 'nothing attached' reason", () => {
    const row = makeRow({ sessionId: "ws-1", attachState: "detached" });
    const action = resolveGoToAction(row);
    expect(action.type).toBe("disabled");
    if (action.type !== "disabled") throw new Error("expected disabled");
    expect(action.reason).toMatch(/nothing attached/i);
  });

  test("null attachState (lookup unavailable/degraded) -> disabled with a distinct 'unavailable' reason", () => {
    const row = makeRow({ sessionId: "ws-1", attachState: null });
    const action = resolveGoToAction(row);
    expect(action.type).toBe("disabled");
    if (action.type !== "disabled") throw new Error("expected disabled");
    // Distinct from the "detached" reason text above (R1 review fix) — a
    // degraded lookup is NOT the same claim as "confirmed nothing attached".
    expect(action.reason).toMatch(/unavailable/i);
    expect(action.reason).not.toMatch(/nothing attached/i);
  });

  test("encodes a sessionId that needs URI escaping in the navigate path", () => {
    const row = makeRow({ sessionId: "ws with space", attachState: "in-cockpit" });
    const action = resolveGoToAction(row);
    expect(action).toEqual({ type: "navigate", path: "/agents/ws%20with%20space/conversation" });
  });
});

describe("resolveGoToAction — non-dispatched-agent kinds", () => {
  test("principal-conversation -> navigate straight to the conversation route", () => {
    const row = makeRow({
      kind: "principal-conversation",
      sessionId: "conv-1",
      attachState: null,
    });
    expect(resolveGoToAction(row)).toEqual({ type: "navigate", path: "/conversation/conv-1" });
  });

  test("driven-session -> navigate to the drive view, regardless of attachState", () => {
    const row = makeRow({
      kind: "driven-session",
      sessionId: "drv-1",
      attachState: "attached-external", // should never be set for this kind, but routing ignores it
    });
    expect(resolveGoToAction(row)).toEqual({ type: "navigate", path: "/driven/drv-1" });
  });

  test("subagent-group -> disabled (synthetic collapsed container, not a real entity)", () => {
    const row = makeRow({ kind: "subagent-group", sessionId: "group:parent-1" });
    const action = resolveGoToAction(row);
    expect(action.type).toBe("disabled");
    if (action.type !== "disabled") throw new Error("expected disabled");
    expect(action.reason).toMatch(/expand/i);
  });
});
