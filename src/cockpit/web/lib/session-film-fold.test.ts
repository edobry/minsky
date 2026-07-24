/**
 * Tests for session-film-fold.ts (mt#3184).
 *
 * Covers the spec's monotone-fold acceptance criterion: "World state at T =
 * fold(events with t_start <= T), monotone under late completions (unpaired
 * intervals render in-flight/unresolved, refined never contradicted)."
 */
import { describe, test, expect } from "bun:test";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { groupEventsIntoBatchRows } from "./session-film-batches";
import { DEFAULT_SESSION_FILM_CONFIG } from "./session-film-config";
import {
  actorKey,
  applyEvent,
  buildKeyframes,
  createEmptyWorldState,
  foldAtBatchIndex,
  foldEvents,
} from "./session-film-fold";

/** Shared fixture target id — extracted to avoid magic-string duplication across this file's cases. */
const DEFAULT_TARGET_ID = "file:workspace:foo.ts";

function ev(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-07-24T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: DEFAULT_TARGET_ID },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

describe("applyEvent — unpaired = in-flight", () => {
  test("an event with outcome undefined renders the entity as in-flight, not ok", () => {
    const state = applyEvent(createEmptyWorldState(), ev({ outcome: undefined }), 0);
    const entity = state.entities.get(DEFAULT_TARGET_ID);
    expect(entity).toBeDefined();
    expect(entity?.lastOutcome).toBeUndefined();
  });

  test("an unpaired event also leaves the acting agent's lastOutcome unresolved", () => {
    const state = applyEvent(createEmptyWorldState(), ev({ outcome: undefined }), 0);
    const agent = state.agents.get("agent:a1");
    expect(agent?.lastOutcome).toBeUndefined();
  });
});

describe("applyEvent — monotone under late completions", () => {
  test("re-applying at the SAME eventIndex with a resolved outcome refines in place", () => {
    const inFlight = applyEvent(createEmptyWorldState(), ev({ outcome: undefined }), 0);
    const refined = applyEvent(
      inFlight,
      ev({ outcome: "ok", tEnd: "2026-07-24T00:00:02.000Z" }),
      0
    );
    const entity = refined.entities.get(DEFAULT_TARGET_ID);
    expect(entity?.lastOutcome).toBe("ok");
  });

  test("a resolved outcome is never regressed back to unresolved by a later re-application", () => {
    const resolved = applyEvent(createEmptyWorldState(), ev({ outcome: "error" }), 0);
    // Simulate a hypothetical "late re-derivation" of the SAME occurrence
    // that (incorrectly) omits the outcome again — the fold must refuse to
    // regress what was already observed.
    const reapplied = applyEvent(resolved, ev({ outcome: undefined }), 0);
    const entity = reapplied.entities.get(DEFAULT_TARGET_ID);
    expect(entity?.lastOutcome).toBe("error");
  });

  test("a genuinely NEW touch of the same target at a DIFFERENT index is not treated as a refinement", () => {
    let state = applyEvent(createEmptyWorldState(), ev({ verb: "read" }), 0);
    state = applyEvent(state, ev({ verb: "write", outcome: "ok" }), 1);
    const entity = state.entities.get(DEFAULT_TARGET_ID);
    expect(entity?.touchCount).toBe(2);
    expect(entity?.lastVerb).toBe("write");
  });
});

describe("actorKey", () => {
  test("distinguishes principal, policy, and agent actors", () => {
    expect(actorKey({ kind: "principal" })).toBe("principal");
    expect(actorKey({ kind: "policy", guardName: "bypass-merge" })).toBe("policy:bypass-merge");
    expect(actorKey({ kind: "agent", agentSessionId: "a1" })).toBe("agent:a1");
  });
});

describe("touched-set accumulation", () => {
  test("touchedEntityIds accumulates across non-conversational touches, skips conversational verbs", () => {
    let state = createEmptyWorldState();
    state = applyEvent(
      state,
      ev({ verb: "read", target: { realm: "repo", id: "file:ws:a.ts" } }),
      0
    );
    state = applyEvent(
      state,
      ev({ verb: "speak", target: { realm: "agents", id: "agents:a1" } }),
      1
    );
    state = applyEvent(
      state,
      ev({ verb: "write", target: { realm: "repo", id: "file:ws:b.ts" } }),
      2
    );
    const agent = state.agents.get("agent:a1");
    expect(agent?.touchedEntityIds.has("file:ws:a.ts")).toBe(true);
    expect(agent?.touchedEntityIds.has("file:ws:b.ts")).toBe(true);
    expect(agent?.touchedEntityIds.has("agents:a1")).toBe(false);
  });
});

describe("thinking shimmer", () => {
  test("thinking is true only until the actor's next event", () => {
    let state = applyEvent(createEmptyWorldState(), ev({ verb: "think" }), 0);
    expect(state.agents.get("agent:a1")?.thinking).toBe(true);
    state = applyEvent(state, ev({ verb: "read" }), 1);
    expect(state.agents.get("agent:a1")?.thinking).toBe(false);
  });

  test("non-agent actors (principal/policy) never shimmer", () => {
    const state = applyEvent(createEmptyWorldState(), ev({ actor: { kind: "principal" } }), 0);
    expect(state.agents.get("principal")?.thinking).toBe(false);
  });
});

describe("foldEvents — full-array recompute", () => {
  test("folding through the last index reflects every event", () => {
    const events: SemanticEvent[] = [
      ev({ target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ target: { realm: "repo", id: "file:ws:b.ts" }, verb: "write" }),
    ];
    const state = foldEvents(events, 1);
    expect(state.entities.size).toBe(2);
    expect(state.lastEventIndex).toBe(1);
  });
});

describe("keyframes + foldAtBatchIndex — cheap reverse scrolling", () => {
  function buildFixture(rowCount: number): SemanticEvent[] {
    const events: SemanticEvent[] = [];
    for (let i = 0; i < rowCount; i++) {
      events.push(
        ev({
          batchId: `b${i}`,
          target: { realm: "repo", id: `file:ws:${i}.ts` },
          tStart: new Date(2026, 6, 24, 0, 0, i).toISOString(),
        })
      );
    }
    return events;
  }

  test("foldAtBatchIndex matches a from-scratch fold at the same batch index", () => {
    const events = buildFixture(60);
    const rows = groupEventsIntoBatchRows(events);
    const config = { ...DEFAULT_SESSION_FILM_CONFIG, keyframeIntervalBatches: 10 };
    const keyframes = buildKeyframes(events, rows, config);
    expect(keyframes.length).toBeGreaterThan(1);

    const target = 37;
    const viaKeyframe = foldAtBatchIndex(events, rows, keyframes, target);
    const fromScratchRow = rows[target];
    if (!fromScratchRow) throw new Error("fixture row missing — test setup bug");
    const lastEventOfRow = fromScratchRow.eventIndices.at(-1);
    if (lastEventOfRow === undefined) throw new Error("fixture row has no events — test setup bug");
    const fromScratch = foldEvents(events, lastEventOfRow);

    expect(viaKeyframe.entities.size).toBe(fromScratch.entities.size);
    expect(viaKeyframe.lastEventIndex).toBe(fromScratch.lastEventIndex);
  });

  test("foldAtBatchIndex(-1) returns empty state (pre-session frame)", () => {
    const events = buildFixture(5);
    const rows = groupEventsIntoBatchRows(events);
    const keyframes = buildKeyframes(events, rows, DEFAULT_SESSION_FILM_CONFIG);
    const state = foldAtBatchIndex(events, rows, keyframes, -1);
    expect(state.entities.size).toBe(0);
  });
});
