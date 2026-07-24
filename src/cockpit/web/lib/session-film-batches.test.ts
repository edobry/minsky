/**
 * Tests for session-film-batches.ts (mt#3184).
 */
import { describe, test, expect } from "bun:test";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import {
  deriveChapters,
  groupEventsIntoBatchRows,
  isWaitRow,
  precedingGapMs,
} from "./session-film-batches";

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

describe("groupEventsIntoBatchRows", () => {
  test("a parallel batch (shared batchId) collapses into ONE row", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:b.ts" } }),
      ev({ batchId: "b1", target: { realm: "web", id: "web:example.com" } }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isParallelBatch).toBe(true);
    expect(rows[0]?.eventIndices).toEqual([0, 1, 2]);
  });

  test("a conversational (no-batchId) event is always its own row", () => {
    const events: SemanticEvent[] = [
      ev({ verb: "speak", batchId: undefined, target: { realm: "agents", id: "agents:a1" } }),
      ev({ verb: "think", batchId: undefined, target: { realm: "agents", id: "agents:a1" } }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.isParallelBatch)).toBe(true);
  });

  test("consecutive singleton tool calls (distinct batchIds) each get their own row", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" }), ev({ batchId: "b2" })];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowIndex).toBe(0);
    expect(rows[1]?.rowIndex).toBe(1);
  });

  test("row tEnd is undefined unless every event in the row resolved", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", tEnd: "2026-07-24T00:00:01.000Z" }),
      ev({ batchId: "b1", tEnd: undefined }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows[0]?.tEnd).toBeUndefined();
  });
});

describe("isWaitRow / precedingGapMs — wait-vs-gap distinction (AT4)", () => {
  test("a row of all-wait events is a wait row, not a capture gap", () => {
    const events: SemanticEvent[] = [ev({ verb: "wait", batchId: undefined })];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(isWaitRow(row as (typeof rows)[number], events)).toBe(true);
  });

  test("a row with a non-wait event is not a wait row", () => {
    const events: SemanticEvent[] = [ev({ verb: "read", batchId: undefined })];
    const rows = groupEventsIntoBatchRows(events);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(isWaitRow(row as (typeof rows)[number], events)).toBe(false);
  });

  test("precedingGapMs computes the silent gap between two rows' timestamps", () => {
    const events: SemanticEvent[] = [
      ev({
        batchId: "b1",
        tStart: "2026-07-24T00:00:00.000Z",
        tEnd: "2026-07-24T00:00:01.000Z",
      }),
      ev({ batchId: "b2", tStart: "2026-07-24T00:05:01.000Z" }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    // 5 minutes = 300_000ms gap between row 0's end and row 1's start.
    expect(precedingGapMs(rows, 1)).toBe(300_000);
    expect(precedingGapMs(rows, 0)).toBe(0);
  });
});

describe("deriveChapters — Skill-invocation chapter boundaries", () => {
  test("a Skill-tool fallback event marks a chapter boundary with its skill name", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1" }),
      ev({
        batchId: "b2",
        verb: "execute",
        target: { realm: "unknown", id: "unknown:Skill", raw: { skill: "cockpit-design" } },
        unmapped: true,
      }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    const chapters = deriveChapters(events, rows);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.rowIndex).toBe(1);
    expect(chapters[0]?.label).toBe("Skill: cockpit-design");
  });

  test("no chapter markers when there are no Skill invocations", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    const rows = groupEventsIntoBatchRows(events);
    expect(deriveChapters(events, rows)).toEqual([]);
  });

  test("falls back to a generic label when no skill name is extractable from raw", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "unknown", id: "unknown:Skill" } }),
    ];
    const rows = groupEventsIntoBatchRows(events);
    expect(deriveChapters(events, rows)[0]?.label).toBe("Skill invocation");
  });
});
