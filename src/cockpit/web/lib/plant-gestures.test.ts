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
});
