/**
 * Tests for session-film-entity-history.ts (mt#3793).
 *
 * Run via: bun test --preload ./tests/setup.ts \
 *   src/cockpit/web/lib/session-film-entity-history.test.ts
 */
import { describe, test, expect } from "bun:test";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { groupEventsIntoBatchRows } from "./session-film-batches";
import { buildKeyframes, foldAtBatchIndex } from "./session-film-fold";
import { DEFAULT_SESSION_FILM_CONFIG } from "./session-film-config";
import { buildEntityHistory, formatActorLabel } from "./session-film-entity-history";

/** The one entity every case here touches — named once so the assertions read against a single subject. */
const FOO = "file:workspace:foo.ts";

function ev(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-08-05T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: FOO },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

describe("buildEntityHistory", () => {
  test("returns only the events touching the requested entity, in order", () => {
    const events = [
      ev({ target: { realm: "repo", id: FOO }, verb: "read" }),
      ev({ target: { realm: "repo", id: "file:workspace:bar.ts" }, verb: "write" }),
      ev({ target: { realm: "repo", id: FOO }, verb: "write" }),
    ];
    const rows = groupEventsIntoBatchRows(events);

    const history = buildEntityHistory(events, rows, FOO);

    expect(history.map((e) => e.verb)).toEqual(["read", "write"]);
    expect(history.map((e) => e.eventIndex)).toEqual([0, 2]);
  });

  test("the entry count matches the fold's touchCount for the same entity", () => {
    // The panel prints `touchCount` beside this list; if the two disagree the
    // operator sees "touched 3 times" above two lines. Both derive from the
    // same array, and this pins that they stay in step.
    const events = [
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "web", id: "web:example.com" } }),
    ];
    const rows = groupEventsIntoBatchRows(events);

    const history = buildEntityHistory(events, rows, FOO);

    expect(history).toHaveLength(3);
  });

  test("carries the BATCH ROW index, so a parallel batch's members all seek to one row", () => {
    // The row is the playhead's addressing unit — three events in one parallel
    // batch are ONE scrub destination, not three.
    const events = [
      ev({ verb: "speak", target: { realm: "agents", id: "agents:a1" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: FOO } }),
      ev({ batchId: "b1", target: { realm: "repo", id: FOO } }),
      ev({ batchId: "b1", target: { realm: "repo", id: FOO } }),
    ];
    const rows = groupEventsIntoBatchRows(events);

    const history = buildEntityHistory(events, rows, FOO);

    expect(history).toHaveLength(3);
    expect(history.map((e) => e.rowIndex)).toEqual([1, 1, 1]);
  });

  test("preserves an unresolved outcome as undefined rather than defaulting it", () => {
    const events = [ev({ outcome: undefined })];
    const rows = groupEventsIntoBatchRows(events);

    const history = buildEntityHistory(events, rows, FOO);

    expect(history[0]?.outcome).toBeUndefined();
  });

  test("stops at the playhead row, so it never lists an action that has not happened yet", () => {
    // Regression: found live at ?t=90, NOT by any test here. Unbounded, the
    // panel rendered four lines under the fold's "touched 3 times" — the fold
    // counts to the playhead, the history was counting the whole film.
    const events = [
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
    ];
    const rows = groupEventsIntoBatchRows(events);

    expect(buildEntityHistory(events, rows, FOO, null, 2)).toHaveLength(3);
    expect(buildEntityHistory(events, rows, FOO, null, 0)).toHaveLength(1);
    // Unbounded stays the default, for callers with no playhead at all.
    expect(buildEntityHistory(events, rows, FOO)).toHaveLength(4);
  });

  test("the bounded count matches what the fold reports at the same playhead", () => {
    // The two numbers the panel prints side by side. This is the invariant the
    // live defect broke; assert it against the fold itself, not a literal.
    const events = [
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "web", id: "web:example.com" } }),
      ev({ target: { realm: "repo", id: FOO } }),
      ev({ target: { realm: "repo", id: FOO } }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    const keyframes = buildKeyframes(events, rows, DEFAULT_SESSION_FILM_CONFIG);

    for (const playhead of [0, 1, 2, 3]) {
      const world = foldAtBatchIndex(events, rows, keyframes, playhead);
      const touchCount = world.entities.get(FOO)?.touchCount ?? 0;
      const history = buildEntityHistory(events, rows, FOO, null, playhead);
      expect(history).toHaveLength(touchCount);
    }
  });

  test("returns an empty array for an entity nothing touched", () => {
    const events = [ev()];
    const rows = groupEventsIntoBatchRows(events);

    expect(buildEntityHistory(events, rows, "file:workspace:never.ts")).toEqual([]);
  });

  test("drops an event no batch row covers instead of fabricating a row", () => {
    // Mismatched inputs: rows derived from a DIFFERENT (shorter) array than the
    // events passed. A fabricated rowIndex would make a history line seek to an
    // unrelated moment, which is worse than the line being absent.
    const events = [ev(), ev(), ev()];
    const rows = groupEventsIntoBatchRows([events[0] as SemanticEvent]);

    const history = buildEntityHistory(events, rows, FOO);

    expect(history).toHaveLength(1);
    expect(history[0]?.rowIndex).toBe(0);
  });
});

describe("formatActorLabel", () => {
  test("names the film's own subject rather than repeating its raw id", () => {
    const label = formatActorLabel({ kind: "agent", agentSessionId: "a1" }, "agents:a1");
    expect(label).toBe("This agent");
  });

  test("a DIFFERENT agent keeps a truncated id, not the subject label", () => {
    const label = formatActorLabel(
      { kind: "agent", agentSessionId: "agent-abcdef123456" },
      "agents:a1"
    );
    expect(label).not.toBe("This agent");
    expect(label).toContain("f123456");
  });

  test("an agent id that merely CONTAINS the subject id is not the subject", () => {
    // Guards the same false-positive `deriveFilmSubjectAgentId` guards: suffix
    // match with the `:` separator, never a bare substring.
    const label = formatActorLabel({ kind: "agent", agentSessionId: "xa1" }, "agents:a1");
    expect(label).not.toBe("This agent");
  });

  test("names the guard on a policy actor", () => {
    const label = formatActorLabel({ kind: "policy", guardName: "block-secret-file-read" }, null);
    expect(label).toBe("Guard block-secret-file-read");
  });

  test("falls back to a bare label when a policy actor carries no guard name", () => {
    expect(formatActorLabel({ kind: "policy" }, null)).toBe("Guard");
  });

  test("labels the principal", () => {
    expect(formatActorLabel({ kind: "principal" }, null)).toBe("Principal");
  });
});
