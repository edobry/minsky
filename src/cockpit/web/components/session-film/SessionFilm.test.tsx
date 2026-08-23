/**
 * SessionFilm tests (mt#3184 AT 3, re-pointed by mt#3461).
 *
 * These moved here from the former `pages/SessionFilmPage.test.tsx` when the
 * film body was extracted from the page (that page and its test have since been
 * deleted outright — mt#3468). The `?t=` deep-link and clamping cases are the
 * ORIGINAL mt#3184 assertions, unchanged except for the route they arrive on —
 * that continuity is the point: the fold, the playhead, and the ribbon behave
 * the same after the re-hosting.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilm.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import {
  SessionFilm,
  filmErrorLeadIn,
  parsePlayheadParam,
  DEFAULT_RIBBON_WIDTH_PX,
  MIN_RIBBON_WIDTH_PX,
  MAX_RIBBON_WIDTH_PX,
} from "./SessionFilm";
import { SessionFilmError } from "../../lib/session-film-client";

const CONVERSATION_ID = "12345678-1234-1234-1234-123456789012";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // The ribbon width persists (mt#3701), so a test that drags leaks into every
  // later test's default unless storage is reset between them.
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function fixtureEvents(count = 10) {
  return Array.from({ length: count }, (_, i) => ({
    schemaVersion: "v0",
    tStart: new Date(2026, 6, 24, 0, 0, i).toISOString(),
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: `file:ws:${i}.ts` },
    outcome: "ok",
    weight: 1,
    batchId: `b${i}`,
    adapterVersion: "test",
  }));
}

/**
 * `code` mirrors the route's real `{error:{code,message}}` body
 * (`routes/session-film.ts`'s `sessionFilmError`) — the client only populates
 * `SessionFilmError.code` from that shape, and mt#4135's lead-in branches on
 * it. It defaults to `session_not_found`, the ordinary no-film case.
 */
function mockEvents({
  status = 200,
  count = 10,
  code = "session_not_found",
}: { status?: number; count?: number; code?: string } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/cockpit/session-film/events") {
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code, message: "mocked failure" } }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ events: fixtureEvents(count), ingestedAt: "2026-07-20T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/**
 * Rows beyond the initially-rendered virtualization window.
 *
 * At `ROW_HEIGHT_PX` 32 and the ribbon's happy-dom fallback viewport of 400px,
 * `computeVisibleRowRange` mounts roughly 13 rows plus 6 overscan either side —
 * about 25. A 120-row fixture targeting row 80 is therefore far outside the
 * window at `scrollTop` 0, which is the whole point: the 10-row fixture used by
 * the other deep-link tests never virtualizes, so those assertions pass whether
 * or not the ribbon ever scrolls (mt#3466).
 */
const VIRTUALIZING_ROW_COUNT = 120;
const FAR_ROW = 80;

function renderFilm(initialPath: string) {
  // `retryDelay: 0` matters for the 5xx cases: SessionFilm's own query sets
  // `retry: sessionFilmRetry`, which OVERRIDES `retry: false` here and retries
  // a non-4xx three times. Without this the error branch is unreachable until
  // ~7s of default exponential backoff elapses — a wall-clock-bound test of
  // exactly the shape mt#3501 exists to stop. 4xx is unaffected either way
  // (sessionFilmRetry refuses to retry it).
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0 } },
  });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route
            path="/conversation/:id/film"
            element={<SessionFilm conversationId={CONVERSATION_ID} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const FILM_PATH = `/conversation/${CONVERSATION_ID}/film`;

describe("parsePlayheadParam", () => {
  test("clamps into range and defaults unparsable input to 0", () => {
    expect(parsePlayheadParam("4", 10)).toBe(4);
    expect(parsePlayheadParam("99999", 10)).toBe(9);
    expect(parsePlayheadParam("-3", 10)).toBe(0);
    expect(parsePlayheadParam("banana", 10)).toBe(0);
    expect(parsePlayheadParam(null, 10)).toBe(0);
    // No rows yet — every value collapses to 0 rather than to -1.
    expect(parsePlayheadParam("4", 0)).toBe(0);
  });
});

describe("SessionFilm — renders without a picker (mt#3461 SC 1)", () => {
  test("loads the film straight from the conversation in the route", async () => {
    mockEvents();
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByTestId("session-film")).toBeDefined();
    });
    expect(screen.getByTestId("session-film-ribbon")).toBeDefined();
    // The picker is gone: nothing to choose, because the route already chose.
    expect(screen.queryByTestId(`session-film-picker-row-${CONVERSATION_ID}`)).toBeNull();
  });
});

describe("SessionFilm — layout balance (mt#3258 SC 4, held through the fold)", () => {
  test("the ribbon rail opens at its narrow default width, not a proportion of the stage", async () => {
    // Asserting the applied width directly: happy-dom has no layout engine, so
    // there is no real box to measure (see src/cockpit/CLAUDE.md — geometry
    // assertions belong in a CDP verify script, not here). The width moved from
    // a `w-64` class to an inline style when mt#3701 made it draggable; the
    // DEFAULT is unchanged, which is what this has always asserted. `shrink-0`
    // matters as much as the width: without it the rail can be squeezed by its
    // flex-1 sibling.
    mockEvents();
    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX}px`);
    expect(ribbon.className).toContain("shrink-0");
  });
});

describe("SessionFilm — draggable ribbon/stage divider (mt#3701)", () => {
  test("dragging the divider resizes the ribbon (SC 1, SC 2)", async () => {
    mockEvents();
    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    const divider = screen.getByTestId("session-film-divider");

    fireEvent.pointerDown(divider, { clientX: 256, button: 0 });
    fireEvent.pointerMove(window, { clientX: 376 });
    fireEvent.pointerUp(window, { clientX: 376 });

    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX + 120}px`);
    expect(divider.getAttribute("aria-valuenow")).toBe(String(DEFAULT_RIBBON_WIDTH_PX + 120));
  });

  test("the clamp holds at both ends (SC 2)", async () => {
    // The container-fraction bound is NOT exercised here — happy-dom measures
    // every box as 0, so `splitWidthPx` stays 0 and the fraction is inert by
    // design (see lib/pane-width.ts). That bound is checked in
    // scripts/verify-session-film-panes.ts against a real layout.
    mockEvents();
    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    const divider = screen.getByTestId("session-film-divider");

    fireEvent.pointerDown(divider, { clientX: 500, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100 });
    expect(ribbon.style.width).toBe(`${MIN_RIBBON_WIDTH_PX}px`);

    fireEvent.pointerMove(window, { clientX: 2500 });
    expect(ribbon.style.width).toBe(`${MAX_RIBBON_WIDTH_PX}px`);
    fireEvent.pointerUp(window, { clientX: 2500 });
  });

  test("arrow keys resize without scrubbing the film (SC 3, SC 4)", async () => {
    mockEvents();
    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    const divider = screen.getByTestId("session-film-divider");
    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-0").getAttribute("aria-current")).toBe("true");
    });

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX + 16}px`);
    // Still on row 0: the film's own window-level ArrowRight handler steps the
    // playhead, and a resize keystroke must not also scrub.
    expect(screen.getByTestId("session-film-row-0").getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX + 16 - 64}px`);

    fireEvent.keyDown(divider, { key: "Home" });
    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX}px`);

    // Control: the same key from outside the divider DOES scrub, so the
    // assertion above is about the divider swallowing it and not about the film
    // having lost its keyboard stepping.
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-1").getAttribute("aria-current")).toBe("true");
    });
  });

  test("the dragged width survives a remount (SC 5)", async () => {
    mockEvents();
    const first = renderFilm(FILM_PATH);
    const divider = await screen.findByTestId("session-film-divider");
    fireEvent.pointerDown(divider, { clientX: 256, button: 0 });
    fireEvent.pointerMove(window, { clientX: 336 });
    fireEvent.pointerUp(window, { clientX: 336 });
    first.unmount();

    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX + 80}px`);
  });

  test("the split is measured once it exists, not only on the loading frame (SC 2)", async () => {
    // The container-fraction bound needs a measured container. This component
    // returns a loading state BEFORE the split exists, so the measurement has
    // to attach when the split mounts — a mount-time effect runs a render too
    // early, finds nothing, and never retries, leaving the bound silently
    // inert. happy-dom reports 0 for every box, so no assertion here can tell
    // "unmeasured" from "measured as 0"; what it CAN tell is whether the
    // observer was ever pointed at the split, which is the defect.
    // scripts/verify-session-film-panes.ts covers the resulting geometry.
    const observed: Element[] = [];
    const RealResizeObserver = globalThis.ResizeObserver;
    class RecordingResizeObserver {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
    try {
      mockEvents();
      renderFilm(FILM_PATH);
      const ribbon = await screen.findByTestId("session-film-ribbon");
      const split = ribbon.parentElement;
      expect(split).not.toBeNull();
      expect(observed).toContain(split as Element);
    } finally {
      globalThis.ResizeObserver = RealResizeObserver;
    }
  });

  test("a corrupt or out-of-range stored width falls back to the default (SC 5)", async () => {
    for (const stored of ["not-a-number", "99999", "-40"]) {
      localStorage.setItem("cockpit.session-film.ribbon-width.v1", stored);
      mockEvents();
      const view = renderFilm(FILM_PATH);
      const ribbon = await screen.findByTestId("session-film-ribbon");
      expect(ribbon.style.width).toBe(`${DEFAULT_RIBBON_WIDTH_PX}px`);
      view.unmount();
    }
  });
});

describe("SessionFilm — ?t= deep link (mt#3184 AT 3, mt#3461 SC 4)", () => {
  test("opens the film with the playhead at the row named by ?t=", async () => {
    mockEvents();
    renderFilm(`${FILM_PATH}?t=4`);

    await waitFor(() => {
      const row4 = screen.getByTestId("session-film-row-4");
      expect(row4.getAttribute("aria-current")).toBe("true");
    });
  });

  test("clamps an out-of-range ?t= to the last row rather than crashing", async () => {
    mockEvents();
    renderFilm(`${FILM_PATH}?t=99999`);

    await waitFor(() => {
      const row9 = screen.getByTestId("session-film-row-9");
      expect(row9.getAttribute("aria-current")).toBe("true");
    });
  });
});

describe("SessionFilm — the ribbon follows the playhead (mt#3466)", () => {
  test("a ?t= far outside the initial window scrolls that row into the ribbon", async () => {
    // The defect: `scrollTop` was driven only BY scrolling, never toward the
    // playhead. A deep link moved the fold and the stage while the ribbon stayed
    // at the top, so on a virtualizing film the playhead row was not merely
    // un-highlighted — it was never mounted, and nothing on screen was current.
    mockEvents({ count: VIRTUALIZING_ROW_COUNT });
    renderFilm(`${FILM_PATH}?t=${FAR_ROW}`);

    await waitFor(() => {
      const row = screen.getByTestId(`session-film-row-${FAR_ROW}`);
      expect(row.getAttribute("aria-current")).toBe("true");
    });
  });

  test("arrowing past the bottom of the window brings the new playhead row along", async () => {
    // Same root cause, second entry point: keyboard stepping moves the playhead
    // in SessionFilm without touching the ribbon's scroll, so without the follow
    // effect the playhead walks off-screen one press at a time.
    mockEvents({ count: VIRTUALIZING_ROW_COUNT });
    renderFilm(`${FILM_PATH}?t=${FAR_ROW}`);

    await waitFor(() => {
      expect(screen.getByTestId(`session-film-row-${FAR_ROW}`)).toBeDefined();
    });

    // Dispatched from document.body, not window (PR #2486 R1): keydown bubbles,
    // so this still reaches SessionFilm's window-level listener, while matching
    // how a real keypress arrives (targeted at the focused element) and not
    // depending on the test file and the component seeing the same `window`
    // object. It also exercises the handler's INPUT/TEXTAREA target check
    // against a realistic target instead of bypassing it.
    fireEvent.keyDown(document.body, { key: "ArrowDown" });

    await waitFor(() => {
      const next = screen.getByTestId(`session-film-row-${FAR_ROW + 1}`);
      expect(next.getAttribute("aria-current")).toBe("true");
    });
  });

  test("a hand scroll is left alone — the playhead follows the scroll, not the reverse", async () => {
    // The regression a naive always-scroll effect would introduce: snapping the
    // ribbon back to the playhead on every render would make it impossible to
    // scroll anywhere. The guard makes the effect a no-op right after a user
    // scroll, because the playhead it just produced already matches scrollTop.
    mockEvents({ count: VIRTUALIZING_ROW_COUNT });
    renderFilm(FILM_PATH);

    const ribbon = await screen.findByTestId("session-film-ribbon");
    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-0")).toBeDefined();
    });

    const target = 40 * 32; // 40 rows down, at ROW_HEIGHT_PX
    ribbon.scrollTop = target;
    fireEvent.scroll(ribbon);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-40")).toBeDefined();
    });
    // Still where the user put it — not yanked back toward row 0.
    expect(ribbon.scrollTop).toBe(target);
  });
});

describe("SessionFilm — ?turn= address arrival (mt#3794)", () => {
  /**
   * Events carrying `sourceRef` — the join key an address resolves against.
   *
   * Turn 103 deliberately produces TWO rows: a conversational `speak` (no
   * `batchId`, so its own row) followed by a two-call parallel batch. That is
   * the ordinary shape of an assistant turn that says something and then acts,
   * and it is the ONLY shape in which `toolUse` changes the answer — with one
   * row per turn, turn-grain and tool-grain would resolve identically and a
   * passing tool-grain test would prove nothing.
   */
  function sourcedEvents() {
    const base = {
      schemaVersion: "v0",
      actor: { kind: "agent", agentSessionId: "a1" },
      target: { realm: "repo", id: "file:ws:x.ts" },
      outcome: "ok",
      weight: 1,
      adapterVersion: "test",
    };
    const at = (s: number) => new Date(2026, 6, 24, 0, 0, s).toISOString();
    return [
      // Rows 0-2 — one plain event each, turns 100-102.
      ...[0, 1, 2].map((i) => ({
        ...base,
        verb: "read",
        tStart: at(i),
        batchId: `b${i}`,
        sourceRef: { turnIndex: 100 + i },
      })),
      // Row 3 — turn 103's prose.
      { ...base, verb: "speak", tStart: at(3), sourceRef: { turnIndex: 103 } },
      // Row 4 — turn 103's parallel batch, two calls sharing one batchId.
      {
        ...base,
        verb: "read",
        tStart: at(4),
        batchId: "bp",
        sourceRef: { turnIndex: 103, toolUseId: "tu-a" },
      },
      {
        ...base,
        verb: "write",
        tStart: at(5),
        batchId: "bp",
        sourceRef: { turnIndex: 103, toolUseId: "tu-b" },
      },
      // Row 5 — turn 104.
      { ...base, verb: "read", tStart: at(6), batchId: "b6", sourceRef: { turnIndex: 104 } },
    ];
  }

  function mockSourcedEvents() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/cockpit/session-film/events") {
        return new Response(
          JSON.stringify({ events: sourcedEvents(), ingestedAt: "2026-07-20T00:00:00.000Z" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("lands on the row whose event came from the named turn", async () => {
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?turn=101`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-1").getAttribute("aria-current")).toBe("true");
    });
  });

  test("a tool-grain address picks the batch row, not the prose row of the same turn", async () => {
    // Turn 103 spans rows 3 (speak) and 4 (the batch). Turn-grain resolves to
    // the first event from that turn — the prose. Only `toolUse` reaches the
    // action the reader actually clicked.
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?turn=103&toolUse=tu-b`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-4").getAttribute("aria-current")).toBe("true");
    });
  });

  test("the same turn WITHOUT a tool id lands on its prose row — the control for the case above", async () => {
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?turn=103`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-3").getAttribute("aria-current")).toBe("true");
    });
  });

  test("a tool id this film has no event for degrades to the turn rather than failing", async () => {
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?turn=103&toolUse=tu-does-not-exist`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-3").getAttribute("aria-current")).toBe("true");
    });
    expect(screen.queryByTestId("session-film-unresolved-address")).toBeNull();
  });

  test("an address matching nothing says so instead of silently opening at the start", async () => {
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?turn=999`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-unresolved-address")).toBeDefined();
    });
    // Landing at row 0 is correct — the note is what distinguishes it from a
    // film that simply opens there.
    expect(screen.getByTestId("session-film-row-0").getAttribute("aria-current")).toBe("true");
  });

  test("the identity address wins over an ordinal in the same URL", async () => {
    mockSourcedEvents();
    renderFilm(`${FILM_PATH}?t=0&turn=104`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-row-5").getAttribute("aria-current")).toBe("true");
    });
  });

  test("an events payload with no sourceRef at all is unaddressable, not a crash", async () => {
    // Every event predating the adapter's `sourceRef` stamping looks like this.
    mockEvents();
    renderFilm(`${FILM_PATH}?turn=101`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-unresolved-address")).toBeDefined();
    });
  });
});

describe("SessionFilm — scrub-gated conversation (mt#3461)", () => {
  test("a reader who arrived from a link is told the MOMENT can't be shown (mt#3794)", async () => {
    // The link is deliberately not gated on film availability — no
    // per-conversation signal exists to gate it on (see RunDetail's filmPath
    // docblock) — so this message is what keeps such a click explained rather
    // than dead.
    mockEvents({ status: 404 });
    renderFilm(`${FILM_PATH}?turn=101`);

    await waitFor(() => {
      expect(screen.getByText(/That moment can't be shown/i)).toBeDefined();
    });
  });

  test("reports no film instead of surfacing a raw failure", async () => {
    // A conversation is reachable from its own page, so this error branch is
    // the only thing between the operator and a raw fetch failure. The status
    // used to be 422 (the film's scrub-gate refusal); mt#3268 / ADR-040
    // removed that gate, so 404 is what an unfetchable film looks like now.
    mockEvents({ status: 404 });
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByText(/This conversation has no film/i)).toBeDefined();
    });
    expect(screen.queryByTestId("session-film")).toBeNull();
  });
});

describe("SessionFilm — the error lead-in names what failed (mt#4135)", () => {
  // The load-bearing assertion in each non-absence case is the NEGATIVE one:
  // before mt#4135 every failure rendered "This conversation has no film",
  // so an operator debugging a broken server was told the film did not exist.

  test("404 session_not_found is the one case that may assert absence", async () => {
    mockEvents({ status: 404, code: "session_not_found" });
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByText(/This conversation has no film/i)).toBeDefined();
    });
  });

  test("404 invalid_id names the id, and does not claim the film is absent", async () => {
    // The route answers 404 for an id `looksLikeConversationId` rejects — a
    // different fact from "no transcript exists", and the one mt#3225's
    // server-side fix was about.
    mockEvents({ status: 404, code: "invalid_id" });
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByText(/not a conversation this cockpit can film/i)).toBeDefined();
    });
    expect(screen.queryByText(/has no film/i)).toBeNull();
  });

  test("a 500 reports a failed read, and does not claim the film is absent", async () => {
    mockEvents({ status: 500, code: "internal" });
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByText(/film could not be loaded/i)).toBeDefined();
    });
    expect(screen.queryByText(/has no film/i)).toBeNull();
  });

  // Directly, because the remaining cases are about inputs the render path
  // cannot easily produce: an error that is not a SessionFilmError at all
  // (a network-level failure), and the deep-link variant of each cause.
  test("anything that is not a SessionFilmError reports a failed read", () => {
    expect(filmErrorLeadIn(new TypeError("Failed to fetch"), false)).toBe(
      "The film could not be loaded"
    );
    expect(filmErrorLeadIn(undefined, false)).toBe("The film could not be loaded");
  });

  test("the deep-link lead-in still names the moment, for every cause (SC4)", () => {
    const causes = [
      new SessionFilmError(404, "session_not_found", "x"),
      new SessionFilmError(404, "invalid_id", "x"),
      new SessionFilmError(500, "internal", "x"),
      new TypeError("Failed to fetch"),
    ];
    for (const cause of causes) {
      expect(filmErrorLeadIn(cause, true)).toStartWith("That moment can't be shown — ");
    }
  });
});

// ── mt#3793: the inspector props reach the stage ─────────────────────────────
//
// The stage's own tests pass `events`/`batchRows`/`onSeekToRow` directly, so
// they prove the panel WORKS and say nothing about whether anything supplies
// them. This is the caller direction: the film is the only production call
// site, and a panel wired to nothing renders an empty history forever while
// every stage test stays green.

describe("SessionFilm — entity inspector wiring (mt#3793)", () => {
  /** Three actions on ONE entity, one per row — so a history line's row index is unambiguous. */
  function mockRepeatedTouches() {
    const events = Array.from({ length: 3 }, (_, i) => ({
      schemaVersion: "v0",
      tStart: new Date(2026, 6, 24, 0, 0, i).toISOString(),
      actor: { kind: "agent", agentSessionId: "a1" },
      verb: i === 0 ? "read" : "write",
      target: { realm: "minsky-substrate", id: "minsky:task:mt#3793" },
      outcome: "ok",
      weight: 1,
      adapterVersion: "test",
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/cockpit/session-film/events") {
        return new Response(JSON.stringify({ events, ingestedAt: "2026-07-20T00:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  function stageEntityNode(): Element {
    const nodes = [...document.querySelectorAll('[data-testid^="session-film-node-"]')];
    const leaf = nodes.find((n) => !(n.getAttribute("data-testid") ?? "").includes("__root__"));
    if (!leaf) throw new Error("no entity node rendered — fixture setup bug");
    return leaf;
  }

  test("the panel shows the entity's full history, which only the film can supply", async () => {
    mockRepeatedTouches();
    renderFilm(`${FILM_PATH}?t=2`);
    await waitFor(() => expect(screen.getByTestId("session-film")).toBeDefined());

    fireEvent.click(stageEntityNode());

    const history = await screen.findByTestId("session-film-entity-history");
    // Three touches -> three lines. With the props unwired this is
    // "No recorded actions." no matter how correct the stage is.
    expect(history.querySelectorAll("button")).toHaveLength(3);
  });

  test("clicking a history line moves the film's playhead, and the URL follows", async () => {
    mockRepeatedTouches();
    // A probe INSIDE the router, because MemoryRouter keeps its location in
    // React state rather than on `window.location` — reading the global here
    // would assert nothing (it never changes) while looking like it did.
    function PlayheadProbe() {
      const [params] = useSearchParams();
      return <span data-testid="playhead-probe">{params.get("t") ?? ""}</span>;
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <MemoryRouter initialEntries={[`${FILM_PATH}?t=2`]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route
              path="/conversation/:id/film"
              element={
                <>
                  <SessionFilm conversationId={CONVERSATION_ID} />
                  <PlayheadProbe />
                </>
              }
            />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByTestId("session-film")).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("playhead-probe").textContent).toBe("2"));

    fireEvent.click(stageEntityNode());
    const history = await screen.findByTestId("session-film-entity-history");
    const firstLine = history.querySelector("button");
    if (!firstLine) throw new Error("history line missing — fixture setup bug");

    fireEvent.click(firstLine);

    // The playhead is reflected into `?t=` by the film's own effect, so moving
    // from 2 to 0 is evidence the seek reached the film's STATE — not merely
    // that a click handler fired.
    await waitFor(() => {
      expect(screen.getByTestId("playhead-probe").textContent).toBe("0");
    });
  });
});
