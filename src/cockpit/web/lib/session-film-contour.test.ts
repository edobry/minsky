/**
 * Tests for session-film-contour.ts (mt#3184 — spec SC 7 / AT 5).
 *
 * AT5: "Avatar click draws the touched contour spanning at least two realm
 * trees on a cross-realm fixture; label reads 'touched'."
 */
import { describe, test, expect } from "bun:test";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { foldAtBatchIndex, buildKeyframes } from "./session-film-fold";
import { groupEventsIntoBatchRows } from "./session-film-batches";
import { computeStageLayout } from "./session-film-layout";
import { DEFAULT_SESSION_FILM_CONFIG } from "./session-film-config";
import {
  computeTouchedSetContourPath,
  touchedSetContourColorClass,
  touchedSetMemberCircles,
  touchedSetRealms,
} from "./session-film-contour";

const MINSKY_SUBSTRATE_REALM = "minsky-substrate";
const FIXTURE_AGENT_MISSING_MESSAGE = "fixture agent missing — test setup bug";

function ev(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-07-24T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: "file:workspace:foo.ts" },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

function buildFixture(events: SemanticEvent[]) {
  const rows = groupEventsIntoBatchRows(events);
  const keyframes = buildKeyframes(events, rows, DEFAULT_SESSION_FILM_CONFIG);
  const world = foldAtBatchIndex(events, rows, keyframes, rows.length - 1);
  const nowIso = events.at(-1)?.tStart ?? "2026-07-24T00:00:00.000Z";
  const layout = computeStageLayout(world, nowIso, DEFAULT_SESSION_FILM_CONFIG);
  return { world, layout };
}

describe("touchedSetRealms / touchedSetMemberCircles — cross-realm spanning (AT5)", () => {
  test("a cross-realm fixture spans at least two realm trees", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({
        batchId: "b2",
        verb: "write",
        target: { realm: MINSKY_SUBSTRATE_REALM, id: "minsky:task:mt#1" },
      }),
    ];
    const { world, layout } = buildFixture(events);
    const agent = world.agents.get("agent:a1");
    if (!agent) throw new Error(FIXTURE_AGENT_MISSING_MESSAGE);

    const realms = touchedSetRealms(agent, layout);
    expect(realms.size).toBeGreaterThanOrEqual(2);
    expect(realms.has("repo")).toBe(true);
    expect(realms.has(MINSKY_SUBSTRATE_REALM)).toBe(true);

    const members = touchedSetMemberCircles(agent, layout, 14);
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  test("a single-realm touched set does not falsely report cross-realm spanning", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b2", target: { realm: "repo", id: "file:ws:b.ts" } }),
    ];
    const { world, layout } = buildFixture(events);
    const agent = world.agents.get("agent:a1");
    if (!agent) throw new Error(FIXTURE_AGENT_MISSING_MESSAGE);
    expect(touchedSetRealms(agent, layout).size).toBe(1);
  });
});

describe("computeTouchedSetContourPath", () => {
  test("returns a non-empty SVG path 'd' string for a >=2-member cross-realm touched set", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({
        batchId: "b2",
        verb: "write",
        target: { realm: MINSKY_SUBSTRATE_REALM, id: "minsky:task:mt#1" },
      }),
    ];
    const { world, layout } = buildFixture(events);
    const agent = world.agents.get("agent:a1");
    if (!agent) throw new Error(FIXTURE_AGENT_MISSING_MESSAGE);
    const path = computeTouchedSetContourPath(agent, layout, DEFAULT_SESSION_FILM_CONFIG);
    expect(path).not.toBeNull();
    expect(typeof path).toBe("string");
    expect((path as string).length).toBeGreaterThan(0);
  });

  test("returns null when fewer than 2 touched nodes are visible (nothing to bubble)", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const { world, layout } = buildFixture(events);
    const agent = world.agents.get("agent:a1");
    if (!agent) throw new Error(FIXTURE_AGENT_MISSING_MESSAGE);
    expect(computeTouchedSetContourPath(agent, layout, DEFAULT_SESSION_FILM_CONFIG)).toBeNull();
  });

  test("returns null for an actor with no touches at all", () => {
    const { layout } = buildFixture([]);
    const principal = { touchedEntityIds: new Set<string>() };
    expect(computeTouchedSetContourPath(principal, layout, DEFAULT_SESSION_FILM_CONFIG)).toBeNull();
  });
});

describe("touchedSetContourColorClass — per-agent brand tokens", () => {
  test("agent -> iso.pastel companion color", () => {
    expect(touchedSetContourColorClass({ kind: "agent" })).toContain("iso-pastel");
  });
  test("principal -> signal-cyan", () => {
    expect(touchedSetContourColorClass({ kind: "principal" })).toContain("signal-cyan");
  });
  test("policy -> warn-red", () => {
    expect(touchedSetContourColorClass({ kind: "policy" })).toContain("warn-red");
  });
});
