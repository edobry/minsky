/**
 * Gesture dictionary + baseline-engine tests (mt#2377 v2.0).
 *
 * The dictionary is the fixed event→gesture vocabulary; the engine enforces
 * idle honesty (first poll baselines, only genuinely-new rows fire).
 */
import { describe, test, expect } from "bun:test";
import { createGestureEngineState, mapEventToGestures, takeNewEvents } from "./plant-gestures";
import type { SystemEventRow } from "../hooks/useSystemEvents";

const STATUS_CHANGED = "task.status_changed";
const CHANGESET_CREATED = "changeset.created";

function row(id: string, eventType: string, payload: Record<string, unknown> = {}): SystemEventRow {
  return { id, eventType, payload, createdAt: "2026-06-12T00:00:00Z" };
}

describe("mapEventToGestures (fixed dictionary)", () => {
  test("task.status_changed → DONE travels review→done and pulses DONE healthy", () => {
    const g = mapEventToGestures(row("1", STATUS_CHANGED, { newStatus: "DONE" }));
    expect(g.edgeDots).toEqual([{ edgeId: "review-to-done", tone: "healthy" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "s1-done", tone: "healthy" }]);
  });

  test("task.status_changed → IN-REVIEW travels agents→pr→review", () => {
    const g = mapEventToGestures(row("1", STATUS_CHANGED, { newStatus: "IN-REVIEW" }));
    expect(g.edgeDots.map((d) => d.edgeId)).toEqual(["agents-to-pr", "pr-to-review"]);
  });

  test("ask.created flashes the seam edge and pulses the seam node", () => {
    const g = mapEventToGestures(row("1", "ask.created"));
    expect(g.edgeFlashes).toEqual([{ edgeId: "s1-to-seam", tone: "seam" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "attention-seam", tone: "seam" }]);
  });

  test("pr.review_posted CHANGES_REQUESTED flashes the recirculation arc", () => {
    const g = mapEventToGestures(row("1", "pr.review_posted", { state: "CHANGES_REQUESTED" }));
    expect(g.edgeFlashes).toEqual([{ edgeId: "recirc", tone: "warn" }]);
  });

  test("pr.review_posted APPROVED pulses REVIEW healthy with no flash", () => {
    const g = mapEventToGestures(row("1", "pr.review_posted", { state: "APPROVED" }));
    expect(g.edgeFlashes).toEqual([]);
    expect(g.nodePulses).toEqual([{ nodeId: "s1-review", tone: "healthy" }]);
  });

  test("subagent.failed flashes the failure edge and pulses AGENTS alarm", () => {
    const g = mapEventToGestures(row("1", "subagent.failed"));
    expect(g.edgeFlashes).toEqual([{ edgeId: "s1-to-learn", tone: "alarm" }]);
    expect(g.nodePulses[0]).toEqual({ nodeId: "s1-agents", tone: "alarm" });
  });

  test("unknown event types produce NO motion (honest-motion law)", () => {
    const g = mapEventToGestures(row("1", "some.future_type"));
    expect(g.edgeDots).toEqual([]);
    expect(g.edgeFlashes).toEqual([]);
    expect(g.nodePulses).toEqual([]);
  });

  test("task.status_changed with unknown status produces NO motion", () => {
    const g = mapEventToGestures(row("1", STATUS_CHANGED, { newStatus: "WAT" }));
    expect(g.edgeDots).toEqual([]);
    expect(g.nodePulses).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // mt#2490 — informational event types (mt#2489 / mt#2537)
  // -------------------------------------------------------------------------

  test("memory.created pulses the learning-loop reservoir, no edge motion", () => {
    const g = mapEventToGestures(
      row("1", "memory.created", { memoryId: "m1", memoryType: "feedback", scope: "global" })
    );
    expect(g.edgeDots).toEqual([]);
    expect(g.edgeFlashes).toEqual([]);
    expect(g.nodePulses).toEqual([{ nodeId: "learning-loop", tone: "learn" }]);
  });

  test("ask.answered flashes the decision edge (distinct from ask.created's ask edge)", () => {
    const g = mapEventToGestures(row("1", "ask.answered", { askId: "a1", responder: "eugene" }));
    expect(g.edgeFlashes).toEqual([{ edgeId: "seam-to-s5", tone: "seam" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "attention-seam", tone: "seam" }]);
    // Distinct from ask.created, which flashes the upward "ask ↑" edge.
    const created = mapEventToGestures(row("2", "ask.created"));
    expect(created.edgeFlashes[0]?.edgeId).not.toBe(g.edgeFlashes[0]?.edgeId);
  });

  test("changeset.created travels pr→review and pulses the review tank", () => {
    const g = mapEventToGestures(row("1", CHANGESET_CREATED, { prNumber: 1780 }));
    expect(g.edgeDots).toEqual([{ edgeId: "pr-to-review", tone: "flow" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "s1-review", tone: "flow" }]);
  });

  test("hook.fired blocked flashes all four S2 valves alarm", () => {
    const g = mapEventToGestures(
      row("1", "hook.fired", { hook: "check-branch-fresh", decision: "blocked" })
    );
    expect(g.edgeDots).toEqual([]);
    expect(g.edgeFlashes).toEqual([]);
    expect(g.nodePulses).toEqual([
      { nodeId: "s2-valve-ready", tone: "alarm" },
      { nodeId: "s2-valve-agents", tone: "alarm" },
      { nodeId: "s2-valve-pr", tone: "alarm" },
      { nodeId: "s2-valve-done", tone: "alarm" },
    ]);
  });

  test("hook.fired overridden flashes all four S2 valves warn", () => {
    const g = mapEventToGestures(
      row("1", "hook.fired", { hook: "some-hook", decision: "overridden" })
    );
    expect(g.nodePulses.every((p) => p.tone === "warn")).toBe(true);
    expect(g.nodePulses.map((p) => p.nodeId)).toEqual([
      "s2-valve-ready",
      "s2-valve-agents",
      "s2-valve-pr",
      "s2-valve-done",
    ]);
  });

  test("mcp.disconnect flickers the supply line and pulses infra-supply warn", () => {
    const g = mapEventToGestures(
      row("1", "mcp.disconnect", { cause: "stdin_close", serverName: "minsky" })
    );
    expect(g.edgeFlashes).toEqual([{ edgeId: "infra-to-s1", tone: "warn" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "infra-supply", tone: "warn" }]);
  });

  test("retrospective.fired welds the learning loop: pulse + new-interlock edge flash", () => {
    const g = mapEventToGestures(row("1", "retrospective.fired", { note: "fixed the thing" }));
    expect(g.edgeFlashes).toEqual([{ edgeId: "learn-to-s1", tone: "learn" }]);
    expect(g.nodePulses).toEqual([{ nodeId: "learning-loop", tone: "learn" }]);
  });

  test("deploy.build and deploy.smoke pulse S4 with the in-flight flow tone", () => {
    for (const eventType of ["deploy.build", "deploy.smoke"]) {
      const g = mapEventToGestures(
        row("1", eventType, { phase: eventType.split(".")[1], status: "running" })
      );
      expect(g.edgeDots).toEqual([]);
      expect(g.edgeFlashes).toEqual([]);
      expect(g.nodePulses).toEqual([{ nodeId: "s4-future", tone: "flow" }]);
    }
  });

  test("deploy.live pulses S4 healthy", () => {
    const g = mapEventToGestures(row("1", "deploy.live", { phase: "live", status: "SUCCESS" }));
    expect(g.nodePulses).toEqual([{ nodeId: "s4-future", tone: "healthy" }]);
  });

  test("deploy.fail pulses S4 alarm", () => {
    const g = mapEventToGestures(row("1", "deploy.fail", { phase: "fail", status: "FAILED" }));
    expect(g.nodePulses).toEqual([{ nodeId: "s4-future", tone: "alarm" }]);
  });
});

describe("takeNewEvents (idle-honesty baseline engine)", () => {
  test("first poll baselines — history is not motion", () => {
    const state = createGestureEngineState();
    const fresh = takeNewEvents(state, [row("a", "ask.created"), row("b", "task.auto_created")]);
    expect(fresh).toEqual([]);
    expect(state.baselined).toBe(true);
  });

  test("subsequent polls return only genuinely-new rows, oldest first", () => {
    const state = createGestureEngineState();
    takeNewEvents(state, [row("a", "ask.created")]);
    // /api/activity is most-recent-first; c is newer than b
    const fresh = takeNewEvents(state, [
      row("c", STATUS_CHANGED),
      row("b", "ask.created"),
      row("a", "ask.created"),
    ]);
    expect(fresh.map((e) => e.id)).toEqual(["b", "c"]);
  });

  test("an unchanged poll fires nothing", () => {
    const state = createGestureEngineState();
    takeNewEvents(state, [row("a", "ask.created")]);
    expect(takeNewEvents(state, [row("a", "ask.created")])).toEqual([]);
  });

  // mt#2490: the new informational types are ordinary rows to the engine —
  // idle honesty holds identically. A pre-existing burst of them at page
  // load is history, not motion; only a genuinely new row after that fires.
  test("a pre-existing burst of the new informational types baselines silently", () => {
    const state = createGestureEngineState();
    const fresh = takeNewEvents(state, [
      row("d", "deploy.live"),
      row("c", "mcp.disconnect"),
      row("b", "retrospective.fired"),
      row("a", CHANGESET_CREATED),
    ]);
    expect(fresh).toEqual([]);
    expect(state.baselined).toBe(true);
  });

  test("a genuinely new informational-type row after baseline fires once", () => {
    const state = createGestureEngineState();
    takeNewEvents(state, [row("a", CHANGESET_CREATED)]);
    const fresh = takeNewEvents(state, [row("b", "hook.fired"), row("a", CHANGESET_CREATED)]);
    expect(fresh.map((e) => e.id)).toEqual(["b"]);
  });
});
