/**
 * ConversationView tail-first windowing tests (mt#2433, mt#3688).
 *
 * Long transcripts were eagerly mounted in full (265 blocks / ~1MB → >20s to
 * first content); the window renders only the most recent INITIAL_TURNS turns.
 * mt#3688 made revealing older turns automatic on scroll, anchored the window to
 * a transcript INDEX rather than a count from the tail, and gave the top of the
 * thread an explicit boundary. These tests feed synthetic snapshots through the
 * public `{ snapshot }` prop (the layout-agnostic path).
 *
 * What is NOT here: the scroll-driven reveal itself and the position readout's
 * live values. Both are geometry, and the component suite runs under happy-dom,
 * which has no layout engine — `scrollHeight`/`clientHeight` read 0, so
 * `isNearTop` is structurally unable to fire (measured mt#3338). Those live in
 * `scripts/verify-conversation-orientation.ts`, which drives a real browser over
 * CDP. Everything below is state, not geometry, and belongs here.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { resetScrollportGeometry } from "../lib/scrollport-test-state";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import { MAX_FROZEN_TURNS } from "../hooks/useThreadWindow";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

// ConversationView renders assistant/user text via <Prose>, which builds its
// entity-index through useEntityIndex (TanStack useQueries) — so a QueryClient
// must be in scope. The synthetic snapshots contain no entity refs, so the
// index stays empty and the queries' (failed) fetches are inert. Mirrors
// ConversationView.errors.test.tsx's provider wrapper.
function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot) {
  const client = createTestQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <ConversationView snapshot={snapshot} />
    </QueryClientProvider>
  );
  return {
    ...utils,
    rerenderCV: (next: SessionContextSnapshot) =>
      utils.rerender(
        <QueryClientProvider client={client}>
          <ConversationView snapshot={next} />
        </QueryClientProvider>
      ),
  };
}

function turnBlock(i: number, role: "user" | "assistant"): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: `turn-${i} body` },
    timestamp: new Date(Date.UTC(2026, 5, 10, 12, 0, i)).toISOString(),
    turnIndex: i,
    // The domain parser (snapshotBlockToConversationTurn) derives the role by
    // branching on rawJsonlType === "user" | "assistant" — these ARE the
    // representative raw line types for turn blocks, not a test shortcut.
    rawJsonlType: role,
  };
}

function syntheticSnapshot(turnCount: number): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [];
  for (let i = 0; i < turnCount; i++) {
    blocks.push(turnBlock(i, i % 2 === 0 ? "user" : "assistant"));
  }
  return {
    agentSessionId: "agent-test-windowing",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-06-10T12:00:00.000Z",
  };
}

/** The "N earlier turns" row's text, or null when the thread shows no hidden turns. */
function hiddenAboveText(): string | null {
  return screen.queryByTestId("thread-hidden-above")?.textContent ?? null;
}

/**
 * Click a reveal control and wait for the resulting render to land.
 *
 * The wait matches the shape of the thing being waited on: a reveal runs inside
 * a React transition (mt#3688), so it is asynchronous by construction, and
 * asserting synchronously after triggering one is relying on `act()` to flush
 * it rather than on anything the code promises.
 */
async function clickAndSettle(label: string, settled: () => boolean): Promise<void> {
  fireEvent.click(screen.getByText(label));
  await waitFor(() => expect(settled()).toBe(true));
}

describe("ConversationView tail-first windowing (mt#2433)", () => {
  beforeEach(resetScrollportGeometry);
  afterEach(cleanup);

  test("small transcript renders fully, and says so", () => {
    renderCV(syntheticSnapshot(10));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.getByText("turn-9 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
    // The beginning is NAMED rather than left as blank space above turn-0 —
    // the mt#3688 complaint was that those two look identical.
    expect(screen.getByTestId("thread-start")).toBeDefined();
  });

  test("large transcript renders only the tail window initially", () => {
    renderCV(syntheticSnapshot(120));
    // Newest turns are rendered…
    expect(screen.getByText("turn-119 body")).toBeDefined();
    expect(screen.getByText("turn-70 body")).toBeDefined();
    // …oldest are not (120 - 50 = 70 hidden: turns 0..69).
    expect(screen.queryByText("turn-0 body")).toBeNull();
    expect(screen.queryByText("turn-69 body")).toBeNull();
    expect(hiddenAboveText()).toContain("70 earlier turns");
    // …and the top of the thread is explicitly NOT the beginning.
    expect(screen.queryByTestId("thread-start")).toBeNull();
  });

  test("revealing a chunk decrements the hidden count", async () => {
    renderCV(syntheticSnapshot(300));
    // 300 - 50 = 250 hidden initially.
    expect(hiddenAboveText()).toContain("250 earlier turns");
    // +100 → 150 hidden.
    await clickAndSettle("show more", () => !!hiddenAboveText()?.includes("150 earlier turns"));
    expect(screen.getByText("turn-150 body")).toBeDefined();
    expect(screen.queryByText("turn-149 body")).toBeNull();
  });

  test("the last chunk reveals the transcript's beginning", async () => {
    renderCV(syntheticSnapshot(120));
    // 70 hidden - 100 → 0: everything is visible and the boundary becomes the
    // start marker rather than disappearing into blank space.
    await clickAndSettle("show more", () => !!screen.queryByTestId("thread-start"));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
  });

  test("jump to the beginning reveals the entire transcript at once", async () => {
    renderCV(syntheticSnapshot(300));
    expect(screen.queryByText("turn-0 body")).toBeNull();
    await clickAndSettle("jump to the beginning", () => !!screen.queryByTestId("thread-start"));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
  });

  test("a PARTIAL reveal survives the same session's transcript growing", async () => {
    // The mt#3688 regression. The window used to be a count from the TAIL, so
    // `slice(length - count)` shifted forward as turns arrived and silently
    // re-hid history the operator had explicitly revealed. Anchored to an INDEX
    // it cannot: turn-150 was revealed, so turn-150 stays revealed.
    const { rerenderCV } = renderCV(syntheticSnapshot(300));
    await clickAndSettle("show more", () => !!hiddenAboveText()?.includes("150 earlier turns"));
    expect(screen.getByText("turn-150 body")).toBeDefined();

    rerenderCV(syntheticSnapshot(360));

    // Still 150 — NOT 360 - 200 = 160, which is what a tail-relative count
    // would have produced, re-hiding turns 150..159.
    expect(hiddenAboveText()).toContain("150 earlier turns");
    expect(screen.getByText("turn-150 body")).toBeDefined();
    expect(screen.getByText("turn-359 body")).toBeDefined();
  });

  test("a full reveal survives the same session's transcript growing", async () => {
    // The pre-existing PR #1667 R1 invariant, preserved: "show all" is now just
    // the index 0, so it holds for the same reason the partial case does.
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    await clickAndSettle("jump to the beginning", () => !!screen.queryByTestId("thread-start"));
    expect(screen.getByText("turn-0 body")).toBeDefined();

    rerenderCV(syntheticSnapshot(180));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.getByText("turn-179 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
  });

  test("window resets to the tail when the session changes", async () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    await clickAndSettle("jump to the beginning", () => !!screen.queryByTestId("thread-start"));
    expect(screen.getByText("turn-0 body")).toBeDefined();

    const other = { ...syntheticSnapshot(120), agentSessionId: "agent-test-windowing-2" };
    rerenderCV(other);
    // New session → back to the clipped tail window.
    expect(screen.queryByText("turn-0 body")).toBeNull();
    expect(hiddenAboveText()).toContain("70 earlier turns");
  });
});

describe("ConversationView window stability while scrolled up (mt#3736)", () => {
  beforeEach(resetScrollportGeometry);
  afterEach(cleanup);

  /**
   * Give the resolved scrollport real geometry, then fire a scroll so the
   * component samples it.
   *
   * Targets `document.scrollingElement` for the reason
   * `ConversationView.scroll-pinning.test.tsx` documents at length: happy-dom
   * lays every element out at zero height, so no ancestor of the sentinel ever
   * satisfies `scrollHeight > clientHeight` and `findScrollParent` resolves to
   * its documented fallback. Stubbing a container instead would hang the
   * geometry off an element the component never listens on, and every case
   * would read as "pinned" — passing whether or not the fix works.
   *
   * Range is 2000 - 400 = 1600px of scroll.
   */
  function scrollTo(scrollTop: number): void {
    const port = document.scrollingElement as HTMLElement;
    Object.defineProperty(port, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(port, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(port, "scrollTop", {
      value: scrollTop,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(port);
  }

  test("an append does not unmount the oldest rendered turn while the reader is scrolled up", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    expect(screen.getByText("turn-70 body")).toBeDefined();

    // 800 is chosen to sit in the one band that isolates this behavior: more
    // than PINNED_THRESHOLD_PX from the bottom (so the reader counts as
    // scrolled up) and more than one viewport from the top (so no automatic
    // reveal fires — a reveal sets an INDEX, which would hold the window still
    // for its own reasons and mask the defect entirely).
    scrollTo(800);

    rerenderCV(syntheticSnapshot(121));

    // Pre-fix, `hiddenBefore` slid 70 → 71: turn-70's DOM was removed from
    // ABOVE the reader, and the content under them moved up by its height with
    // no scroll event of any kind.
    expect(screen.getByText("turn-70 body")).toBeDefined();
    expect(screen.getByText("turn-120 body")).toBeDefined();
    expect(hiddenAboveText()).toContain("70 earlier turns");
  });

  test("the window holds across many appends, not just one", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    scrollTo(800);
    rerenderCV(syntheticSnapshot(160));
    expect(screen.getByText("turn-70 body")).toBeDefined();
    expect(hiddenAboveText()).toContain("70 earlier turns");
  });

  test("returning to the bottom releases the window back to the tail", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    scrollTo(800);
    rerenderCV(syntheticSnapshot(160));
    expect(hiddenAboveText()).toContain("70 earlier turns");

    // 1600 of a 1600px range — exactly at the bottom. The extra turns the
    // freeze accumulated unmount here, which is safe precisely because the
    // reader is at the bottom: the scroll range shortens under a clamped
    // `scrollTop` and nothing they can see moves.
    scrollTo(1600);
    expect(hiddenAboveText()).toContain("110 earlier turns");
  });

  test("a reader who never scrolls still gets the tail-tracking window", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    rerenderCV(syntheticSnapshot(121));
    // The render budget mt#2433 established is unchanged for the common case.
    expect(hiddenAboveText()).toContain("71 earlier turns");
    expect(screen.queryByText("turn-70 body")).toBeNull();
  });

  test("the frozen window is bounded: the tail stops mounting past the cap", () => {
    // The freeze holds the window's START; without a bound on its END, a reader
    // parked in history during a long run accumulates mounted turns until the
    // thread costs what mt#2433 measured — arrived at gradually rather than at
    // once (PR #2648 R1).
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    scrollTo(800);
    rerenderCV(syntheticSnapshot(600));

    // Rendered range is [70, 70 + MAX_FROZEN_TURNS).
    expect(screen.getByText("turn-70 body")).toBeDefined();
    expect(screen.getByText(`turn-${70 + MAX_FROZEN_TURNS - 1} body`)).toBeDefined();
    expect(screen.queryByText(`turn-${70 + MAX_FROZEN_TURNS} body`)).toBeNull();
    expect(screen.queryByText("turn-599 body")).toBeNull();
  });

  test("returning to the bottom un-caps and lands on the newest turn", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    scrollTo(800);
    rerenderCV(syntheticSnapshot(600));
    expect(screen.queryByText("turn-599 body")).toBeNull();

    scrollTo(1600);
    expect(screen.getByText("turn-599 body")).toBeDefined();
    // …and back onto the tail-derived window, not a frozen slice of it.
    expect(hiddenAboveText()).toContain("550 earlier turns");
  });

  test("capping never applies to a reader who is following the tail", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    rerenderCV(syntheticSnapshot(600));
    // Never scrolled: the newest turn is mounted, cap or no cap.
    expect(screen.getByText("turn-599 body")).toBeDefined();
  });

  test("an explicit reveal still wins over the freeze", async () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(300));
    scrollTo(800);
    await clickAndSettle("show more", () => !!hiddenAboveText()?.includes("150 earlier turns"));
    rerenderCV(syntheticSnapshot(360));
    // `revealedFrom` is checked first, so the revealed history stays revealed
    // rather than being pinned back to wherever the freeze happened to land.
    expect(hiddenAboveText()).toContain("150 earlier turns");
    expect(screen.getByText("turn-150 body")).toBeDefined();
  });
});

describe("ConversationView thread position readout (mt#3688)", () => {
  beforeEach(resetScrollportGeometry);
  afterEach(cleanup);

  test("the denominator is the WHOLE transcript, not the rendered window", () => {
    renderCV(syntheticSnapshot(300));
    // 50 of 300 turns are mounted, but the readout counts all 300 — a position
    // derived from the rendered window alone would report "50" and tell the
    // operator they are at the end of a conversation they have barely opened.
    expect(screen.getByTestId("thread-position").textContent).toContain("/ 300");
  });

  test("the unrendered region is drawn in proportion to the whole transcript", () => {
    renderCV(syntheticSnapshot(200));
    // 150 of 200 hidden → the ghosted leading segment covers 75% of the track.
    const unrendered = screen.getByTestId("thread-position-unrendered");
    expect((unrendered as HTMLElement).style.width).toBe("75.00%");
  });

  test("the unrendered region disappears once everything is revealed", async () => {
    renderCV(syntheticSnapshot(200));
    await clickAndSettle("jump to the beginning", () => !!screen.queryByTestId("thread-start"));
    expect(screen.queryByTestId("thread-position-unrendered")).toBeNull();
    expect(screen.getByTestId("thread-position").textContent).toContain("/ 200");
  });

  test("a transcript short enough to render whole shows no readout", () => {
    // Below INITIAL_TURNS every turn is mounted, so the native scrollbar is
    // already honest and a floating readout would be chrome for its own sake.
    renderCV(syntheticSnapshot(10));
    expect(screen.queryByTestId("thread-position")).toBeNull();
  });
});
