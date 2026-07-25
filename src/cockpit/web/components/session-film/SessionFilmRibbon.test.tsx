/**
 * Tests for SessionFilmRibbon.tsx (mt#3184).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilmRibbon.test.tsx
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { deriveChapters, groupEventsIntoBatchRows } from "../../lib/session-film-batches";
import { ROW_HEIGHT_PX, SessionFilmRibbon } from "./SessionFilmRibbon";

afterEach(() => cleanup());

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

function renderRibbon(events: SemanticEvent[], overrides: Partial<Parameters<typeof SessionFilmRibbon>[0]> = {}) {
  const rows = groupEventsIntoBatchRows(events);
  const chapters = deriveChapters(events, rows);
  const onSelectRow = mock(() => {});
  const onScrollRowChange = mock(() => {});
  render(
    <SessionFilmRibbon
      events={events}
      batchRows={rows}
      chapters={chapters}
      playheadRowIndex={0}
      selectedRowIndex={null}
      onSelectRow={onSelectRow}
      onScrollRowChange={onScrollRowChange}
      {...overrides}
    />
  );
  return { rows, chapters, onSelectRow, onScrollRowChange };
}

describe("SessionFilmRibbon — batch-grain rows (AT1)", () => {
  test("a parallel batch renders as ONE expandable row summarizing 'N parallel actions'", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:b.ts" } }),
      ev({ batchId: "b1", target: { realm: "web", id: "web:example.com" } }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.textContent).toContain("3 parallel actions");
  });

  test("clicking a row fires onSelectRow with that row's index", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" }), ev({ batchId: "b2" })];
    const { onSelectRow } = renderRibbon(events);
    fireEvent.click(screen.getByTestId("session-film-row-1"));
    expect(onSelectRow).toHaveBeenCalledWith(1);
  });

  test("the playhead row carries aria-current", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" }), ev({ batchId: "b2" })];
    renderRibbon(events, { playheadRowIndex: 1 });
    expect(screen.getByTestId("session-film-row-1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("session-film-row-0").getAttribute("aria-current")).toBeNull();
  });
});

describe("SessionFilmRibbon — wait vs. capture-gap distinction (AT4)", () => {
  test("a wait event renders a distinct wait marker, not a capture-gap annotation", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", tStart: "2026-07-24T00:00:00.000Z", tEnd: "2026-07-24T00:00:01.000Z" }),
      ev({ verb: "wait", batchId: undefined, tStart: "2026-07-24T00:05:00.000Z" }),
    ];
    renderRibbon(events);
    const waitRow = screen.getByTestId("session-film-row-1");
    expect(waitRow.getAttribute("data-wait")).toBe("true");
    expect(waitRow.getAttribute("data-capture-gap")).toBeNull();
    expect(screen.getByTestId("session-film-wait-marker")).toBeDefined();
  });

  test("a silent gap with NO wait event renders a distinct capture-gap annotation", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", tStart: "2026-07-24T00:00:00.000Z", tEnd: "2026-07-24T00:00:01.000Z" }),
      ev({ batchId: "b2", tStart: "2026-07-24T00:05:00.000Z" }),
    ];
    renderRibbon(events);
    const gapRow = screen.getByTestId("session-film-row-1");
    expect(gapRow.getAttribute("data-capture-gap")).toBe("true");
    expect(gapRow.getAttribute("data-wait")).toBeNull();
    expect(screen.getByTestId("session-film-capture-gap")).toBeDefined();
  });
});

describe("SessionFilmRibbon — chapter headers", () => {
  test("a Skill-invocation row carries its chapter label", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1" }),
      ev({
        batchId: "b2",
        target: { realm: "unknown", id: "unknown:Skill", raw: { skill: "product-thinking" } },
        unmapped: true,
      }),
    ];
    renderRibbon(events);
    expect(screen.getByTestId("session-film-chapter-label").textContent).toBe(
      "Skill: product-thinking"
    );
  });
});

describe("SessionFilmRibbon — virtualization (SC 4)", () => {
  test("a long session mounts only a bounded window of rows, not all of them", () => {
    const events: SemanticEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(ev({ batchId: `b${i}`, target: { realm: "repo", id: `file:ws:${i}.ts` } }));
    }
    renderRibbon(events);
    const mounted = screen.getAllByRole("listitem");
    // Container clientHeight defaults to 0 in happy-dom -> component falls
    // back to a 400px viewport assumption; well under 500 rows regardless.
    expect(mounted.length).toBeLessThan(500);
    expect(mounted.length).toBeGreaterThan(0);
  });

  test("scrolling fires onScrollRowChange", () => {
    const events: SemanticEvent[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(ev({ batchId: `b${i}` }));
    }
    const { onScrollRowChange } = renderRibbon(events);
    const container = screen.getByTestId("session-film-ribbon");
    fireEvent.scroll(container, { target: { scrollTop: ROW_HEIGHT_PX * 10 } });
    expect(onScrollRowChange).toHaveBeenCalled();
  });
});
