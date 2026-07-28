/**
 * Tests for SessionFilmRibbon.tsx (mt#3184).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilmRibbon.test.tsx
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import { deriveChapters, groupEventsIntoBatchRows } from "../../lib/session-film-batches";
import { ROW_HEIGHT_PX, SessionFilmRibbon } from "./SessionFilmRibbon";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

// EntityRef's label-resolution channel (mt#3174) fetches in the background;
// stub it to a harmless degraded response so tests exercise the "bare id,
// no resolved label yet" rendering path deterministically, not a real
// network call or an unresolved hanging promise.
function stubEntityLabelFetch() {
  global.fetch = mock(async () => ({
    ok: false,
    json: async () => ({ state: "degraded", reason: "not mocked in test" }),
  })) as unknown as typeof fetch;
}

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
  stubEntityLabelFetch();
  const rows = groupEventsIntoBatchRows(events);
  const chapters = deriveChapters(events, rows);
  const onSelectRow = mock(() => {});
  const onScrollRowChange = mock(() => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
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
      </MemoryRouter>
    </QueryClientProvider>
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
    // Row role is "button" (mt#3258 SC 5 — was "listitem"; see
    // SessionFilmRibbon.tsx's module doc for the accessibility fix).
    const mounted = screen.getAllByRole("button");
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

describe("SessionFilmRibbon — glyphic rows (mt#3226 SC 2 / AT 3)", () => {
  test("a row renders a verb icon and a realm-color swatch", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", verb: "execute", target: { realm: "shell", id: "shell:git status" } }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.querySelector('[data-testid="session-film-row-icon"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="session-film-realm-swatch"]')).not.toBeNull();
    expect(row.textContent).toContain("git status");
  });

  test("a row whose target is a routable minsky-substrate entity renders via EntityRef (an in-SPA link)", () => {
    const events: SemanticEvent[] = [
      ev({
        batchId: "b1",
        verb: "read",
        target: { realm: "minsky-substrate", id: "minsky:task:mt#1772" },
      }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    const link = row.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/tasks/mt%231772");
    expect(row.textContent).toContain("mt#1772");
  });

  test("a row whose target has no routable counterpart renders a plain label, not a link", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", verb: "read", target: { realm: "repo", id: "file:ws:src/App.tsx" } }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.querySelector("a")).toBeNull();
    expect(row.textContent).toContain("src/App.tsx");
  });

  test("a parallel batch row still renders its own batch icon (not a bespoke duplicate)", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", target: { realm: "repo", id: "file:ws:b.ts" } }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.querySelector('[data-testid="session-film-row-icon"]')).not.toBeNull();
  });
});

describe("SessionFilmRibbon — actor-change marker (mt#3226 SC 2 / AT 2)", () => {
  test("a single-actor fixture renders NO actor markers at all", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", actor: { kind: "agent", agentSessionId: "a1" } }),
      ev({ batchId: "b2", actor: { kind: "agent", agentSessionId: "a1" } }),
    ];
    renderRibbon(events);
    expect(screen.queryAllByTestId("session-film-actor-marker")).toHaveLength(0);
  });

  test("a principal interjection row carries exactly one actor marker", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", actor: { kind: "agent", agentSessionId: "a1" } }),
      ev({ batchId: "b2", verb: "respond", actor: { kind: "principal" } }),
    ];
    renderRibbon(events);
    const changedRow = screen.getByTestId("session-film-row-1");
    expect(changedRow.getAttribute("data-actor-change")).toBe("true");
    expect(
      changedRow.querySelector('[data-testid="session-film-actor-marker"]')
    ).not.toBeNull();
    const unchangedRow = screen.getByTestId("session-film-row-0");
    expect(unchangedRow.getAttribute("data-actor-change")).toBeNull();
  });
});

describe("SessionFilmRibbon — self-reference elision (mt#3231 SC 1 / AT 1)", () => {
  test("a row targeting the film's own subject agent renders the compact self-reference, not the raw repeated id", () => {
    const events: SemanticEvent[] = [
      // A self-targeting `think` event reveals the subject agent id.
      ev({
        batchId: "b1",
        verb: "think",
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents", id: "agents:a1" },
      }),
      // A SECOND self-targeting event — this is the repetition finding 1
      // diagnosed: without elision, this row would ALSO print "a1".
      ev({
        batchId: "b2",
        verb: "speak",
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents", id: "agents:a1" },
      }),
    ];
    renderRibbon(events);
    const row0 = screen.getByTestId("session-film-row-0");
    const row1 = screen.getByTestId("session-film-row-1");
    expect(row0.querySelector('[data-testid="session-film-self-ref"]')).not.toBeNull();
    expect(row1.querySelector('[data-testid="session-film-self-ref"]')).not.toBeNull();
    expect(row0.textContent).not.toContain("agents:a1");
  });

  test("a REAL spawn target (a different agent, e.g. agents:Explore) still renders its own meaningful label, not elided", () => {
    const events: SemanticEvent[] = [
      ev({
        batchId: "b1",
        verb: "think",
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents", id: "agents:a1" },
      }),
      ev({
        batchId: "b2",
        verb: "spawn",
        actor: { kind: "agent", agentSessionId: "a1" },
        target: { realm: "agents", id: "agents:Explore" },
      }),
    ];
    renderRibbon(events);
    const spawnRow = screen.getByTestId("session-film-row-1");
    expect(spawnRow.querySelector('[data-testid="session-film-self-ref"]')).toBeNull();
    expect(spawnRow.textContent).toContain("Explore");
  });
});

describe("SessionFilmRibbon — icon + text-label badges (mt#3231 SC 2 / AT 2)", () => {
  test("a row's icon badge carries a human-readable verb label beside the icon, from the shared registry", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "read" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    const badge = row.querySelector('[data-testid="session-film-row-icon-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.querySelector('[data-testid="session-film-row-icon"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="session-film-verb-label"]')?.textContent).toBe("Read");
  });

  test("a parallel-batch row's badge carries the batch label, not a per-verb label", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" }), ev({ batchId: "b1" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.querySelector('[data-testid="session-film-verb-label"]')?.textContent).toBe("Batch");
  });
});

describe("SessionFilmRibbon — click-to-expand inline accordion (mt#3231 SC 3 / AT 3)", () => {
  test("clicking a row flips aria-expanded and reveals its detail; clicking again collapses it", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1", verb: "write" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("session-film-row-detail-0")).toBeNull();

    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("session-film-row-detail-0");
    expect(detail.textContent).toContain("Write");

    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("session-film-row-detail-0")).toBeNull();
  });

  test("expanding is keyboard-accessible via Enter", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("session-film-row-detail-0")).toBeDefined();
  });

  test("a batch row expands to list its individual member events", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", verb: "read", target: { realm: "repo", id: "file:ws:a.ts" } }),
      ev({ batchId: "b1", verb: "write", target: { realm: "repo", id: "file:ws:b.ts" } }),
      ev({ batchId: "b1", verb: "search", target: { realm: "web", id: "web:example.com" } }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    fireEvent.click(row);
    expect(screen.getByTestId("session-film-row-detail-event-0")).toBeDefined();
    expect(screen.getByTestId("session-film-row-detail-event-1")).toBeDefined();
    expect(screen.getByTestId("session-film-row-detail-event-2")).toBeDefined();
    const detail = screen.getByTestId("session-film-row-detail-0");
    expect(detail.textContent).toContain("a.ts");
    expect(detail.textContent).toContain("b.ts");
    expect(detail.textContent).toContain("example.com");
  });

  test("clicking a row still fires onSelectRow (the external hook stays wired)", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" }), ev({ batchId: "b2" })];
    const { onSelectRow } = renderRibbon(events);
    fireEvent.click(screen.getByTestId("session-film-row-1"));
    expect(onSelectRow).toHaveBeenCalledWith(1);
  });
});

describe("SessionFilmRibbon — row accessibility (mt#3258 SC 5)", () => {
  test("a row exposes role=button + aria-expanded (was role=listitem, which drops aria-expanded from the a11y tree)", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-expanded")).not.toBeNull();
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  test("Enter and Space both toggle expansion; click also toggles it", () => {
    const events: SemanticEvent[] = [ev({ batchId: "b1" })];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");

    fireEvent.keyDown(row, { key: " " });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(row, { key: " " });
    expect(row.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  test("the ribbon container is a labeled group (role=list would require listitem children, invalid alongside role=button rows)", () => {
    renderRibbon([ev({ batchId: "b1" })]);
    const container = screen.getByTestId("session-film-ribbon");
    expect(container.getAttribute("role")).toBe("group");
    expect(container.getAttribute("aria-label")).toBe("Session event ribbon");
  });
});

describe("SessionFilmRibbon — start/end-of-session affordance (mt#3258 SC 1, minor)", () => {
  test("renders a non-empty label inside the leading and trailing spacers", () => {
    renderRibbon([ev({ batchId: "b1" })]);
    expect(screen.getByTestId("session-film-start-marker").textContent).toBe("start of session");
    expect(screen.getByTestId("session-film-end-marker").textContent).toBe("end of session");
  });
});

describe("SessionFilmRibbon — unknown-target fallback never leaks 'unknown:' (mt#3258 SC 3)", () => {
  test("a target that fell through the adapter's total fallback renders a clean muted label, never the literal 'unknown:' prefix", () => {
    const events: SemanticEvent[] = [
      ev({ batchId: "b1", target: { realm: "unknown", id: "unknown:SomeNewTool" }, unmapped: true }),
    ];
    renderRibbon(events);
    const row = screen.getByTestId("session-film-row-0");
    expect(row.textContent).not.toContain("unknown:");
    expect(row.textContent).toContain("SomeNewTool");
    const label = screen.getByTestId("session-film-unknown-target");
    expect(label.className).toContain("text-muted-foreground");
  });
});

// mt#3262: expanded rows show the REAL content of the event, fetched lazily
// via the film-owned content endpoint and rendered with ConversationView's
// own shared renderers, plus a deep-link.
describe("SessionFilmRibbon — expanded row real content (mt#3262 SC 2 / SC 3 / AT 2 / AT 3 / AT 4)", () => {
  function mockContentFetch(
    outcome:
      | { ok: true; blocks: unknown[]; ingestedAt: string | null }
      | { ok: false; status: number; code: string }
  ) {
    global.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/cockpit/session-film/content")) {
        if (outcome.ok) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ blocks: outcome.blocks, ingestedAt: outcome.ingestedAt }),
          } as unknown as Response;
        }
        const body = { error: { code: outcome.code, message: "refused" } };
        return {
          ok: false,
          status: outcome.status,
          text: async () => JSON.stringify(body),
          json: async () => body,
        } as unknown as Response;
      }
      // Entity-label / any other fetch degrades harmlessly (mirrors stubEntityLabelFetch).
      return { ok: false, json: async () => ({ state: "degraded", reason: "not mocked" }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  // Self-targeting so `deriveFilmSubjectAgentId` resolves "a1" — the
  // conversation id the content fetch/deep-link key off, per the module
  // doc's "no new prop threading needed" note.
  function selfEvent(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
    return ev({ target: { realm: "agents", id: "agents:a1" }, ...overrides });
  }

  test("expanding a SPEAK row fetches content lazily and renders the real message text via the shared ElementView", async () => {
    const speakEvent = selfEvent({
      verb: "speak",
      weight: 1,
      sourceRef: { turnIndex: 1, messageUuid: "line-1" },
    });
    const blocks = [
      {
        id: "a1:turn:1",
        type: "assistant-text",
        source: "observed",
        content: { role: "assistant", content: [{ type: "text", text: "Reading the file now." }] },
        timestamp: "2026-07-24T00:00:00.000Z",
        turnIndex: 1,
        rawJsonlType: "assistant",
      },
    ];
    renderRibbon([speakEvent]);
    mockContentFetch({ ok: true, blocks, ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    await screen.findByTestId("session-film-row-content-body");
    expect(screen.getByTestId("session-film-row-content-body").textContent).toContain(
      "Reading the file now."
    );
  });

  test("expanding an ASK row renders the real prompt text", async () => {
    const askEvent = selfEvent({
      verb: "ask",
      actor: { kind: "principal" },
      sourceRef: { turnIndex: 0 },
    });
    // A companion agent-kind event is needed so `filmConversationId`
    // (derived from an agent actor's agentSessionId — see the module doc
    // comment) resolves; a film consisting of ONLY a principal ask with no
    // agent event at all is a degenerate case outside this test's target
    // (it would correctly degrade to "no content", per AT 4, since there's
    // no id to fetch against).
    const companionEvent = selfEvent({
      verb: "speak",
      tStart: "2026-07-24T00:00:01.000Z",
      sourceRef: { turnIndex: 2 },
    });
    const blocks = [
      {
        id: "a1:turn:0",
        type: "user-prompt",
        source: "observed",
        content: { role: "user", content: "please fix the bug" },
        timestamp: "2026-07-24T00:00:00.000Z",
        turnIndex: 0,
        rawJsonlType: "user",
      },
    ];
    renderRibbon([askEvent, companionEvent]);
    mockContentFetch({ ok: true, blocks, ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    await screen.findByTestId("session-film-row-content-body");
    expect(screen.getByTestId("session-film-row-content-body").textContent).toContain(
      "please fix the bug"
    );
  });

  // mt#3276: a thinking block ALWAYS arrives with empty text (the signature is
  // kept for API replay; the reasoning text is withheld server-side and never
  // reaches the client). The row must say so, rather than showing the generic
  // "No content captured" copy — which would blame a Minsky capture gap for a
  // harness limitation — or an empty ElementView box.
  test("expanding a THINK row whose thinking text is empty says the harness does not record it", async () => {
    const thinkEvent = selfEvent({
      verb: "think",
      weight: 0,
      sourceRef: { turnIndex: 3, messageUuid: "line-3" },
    });
    const blocks = [
      {
        id: "a1:turn:3",
        type: "assistant-thinking",
        source: "observed",
        content: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", signature: "abc123" }],
        },
        timestamp: "2026-07-24T00:00:00.000Z",
        turnIndex: 3,
        rawJsonlType: "assistant",
      },
    ];
    renderRibbon([thinkEvent]);
    mockContentFetch({ ok: true, blocks, ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));

    const el = await screen.findByTestId("session-film-row-content-thinking-not-recorded");
    expect(el.textContent).toContain("does not record thinking text");
    // Neither of the two misleading states is used for this case.
    expect(screen.queryByTestId("session-film-row-content-empty")).toBeNull();
    expect(screen.queryByTestId("session-film-row-content-body")).toBeNull();
  });

  test("expanding a tool-call (WRITE) row renders the call's params+result via ToolInvocation", async () => {
    const writeEvent = ev({
      verb: "write",
      target: { realm: "repo", id: "file:workspace:a.ts" },
      sourceRef: { turnIndex: 1, toolUseId: "call-a" },
    });
    const blocks = [
      {
        id: "a1:turn:1",
        type: "assistant-text",
        source: "observed",
        content: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-a", name: "session_write_file", input: { path: "a.ts" } },
          ],
        },
        timestamp: "2026-07-24T00:00:00.000Z",
        turnIndex: 1,
        rawJsonlType: "assistant",
      },
      {
        id: "a1:turn:2",
        type: "user-prompt",
        source: "observed",
        content: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "written ok", is_error: false },
          ],
        },
        timestamp: "2026-07-24T00:00:01.000Z",
        turnIndex: 2,
        rawJsonlType: "user",
      },
    ];
    renderRibbon([writeEvent]);
    mockContentFetch({ ok: true, blocks, ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    const body = await screen.findByTestId("session-film-row-content-body");
    // ToolInvocation renders the call name + args digest + outcome as its
    // collapsed summary line — the real params/result, not a placeholder.
    expect(body.textContent).toContain("session_write_file");
    expect(body.textContent).toContain("a.ts");
    expect(body.textContent).toContain("ok");
  });

  test("expanded row content includes an 'open in conversation view' deep-link to /conversation/:id", async () => {
    const speakEvent = selfEvent({ verb: "speak", sourceRef: { turnIndex: 1 } });
    renderRibbon([speakEvent]);
    mockContentFetch({ ok: true, blocks: [], ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    const link = await screen.findByText("open in conversation view →");
    expect(link.closest("a")?.getAttribute("href")).toBe("/conversation/a1");
  });

  test("a 422 scrub-gate refusal from the content endpoint renders 'Content unavailable', never a crash (AT4/AT5)", async () => {
    const speakEvent = selfEvent({ verb: "speak", sourceRef: { turnIndex: 1 } });
    renderRibbon([speakEvent]);
    mockContentFetch({ ok: false, status: 422, code: "unscrubbed" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    const errorEl = await screen.findByTestId("session-film-row-content-error");
    expect(errorEl.textContent).toBe("Content unavailable.");
  });

  test("an event with no sourceRef renders 'No content captured for this event' (AT4 graceful degrade)", async () => {
    const eventNoRef = selfEvent({ verb: "speak" });
    renderRibbon([eventNoRef]);
    mockContentFetch({ ok: true, blocks: [], ingestedAt: "2026-07-20T00:00:00.000Z" });
    fireEvent.click(screen.getByTestId("session-film-row-0"));
    const emptyEl = await screen.findByTestId("session-film-row-content-empty");
    expect(emptyEl.textContent).toContain("No content captured");
  });
});
