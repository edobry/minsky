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
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
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

describe("ConversationView tail-first windowing (mt#2433)", () => {
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

  test("revealing a chunk decrements the hidden count", () => {
    renderCV(syntheticSnapshot(300));
    // 300 - 50 = 250 hidden initially.
    expect(hiddenAboveText()).toContain("250 earlier turns");
    fireEvent.click(screen.getByText("show more"));
    // +100 → 150 hidden.
    expect(hiddenAboveText()).toContain("150 earlier turns");
    expect(screen.getByText("turn-150 body")).toBeDefined();
    expect(screen.queryByText("turn-149 body")).toBeNull();
  });

  test("the last chunk reveals the transcript's beginning", () => {
    renderCV(syntheticSnapshot(120));
    fireEvent.click(screen.getByText("show more"));
    // 70 hidden - 100 → 0: everything is visible and the boundary becomes the
    // start marker rather than disappearing into blank space.
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
    expect(screen.getByTestId("thread-start")).toBeDefined();
  });

  test("jump to the beginning reveals the entire transcript at once", () => {
    renderCV(syntheticSnapshot(300));
    expect(screen.queryByText("turn-0 body")).toBeNull();
    fireEvent.click(screen.getByText("jump to the beginning"));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
    expect(screen.getByTestId("thread-start")).toBeDefined();
  });

  test("a PARTIAL reveal survives the same session's transcript growing", () => {
    // The mt#3688 regression. The window used to be a count from the TAIL, so
    // `slice(length - count)` shifted forward as turns arrived and silently
    // re-hid history the operator had explicitly revealed. Anchored to an INDEX
    // it cannot: turn-150 was revealed, so turn-150 stays revealed.
    const { rerenderCV } = renderCV(syntheticSnapshot(300));
    fireEvent.click(screen.getByText("show more"));
    expect(hiddenAboveText()).toContain("150 earlier turns");
    expect(screen.getByText("turn-150 body")).toBeDefined();

    rerenderCV(syntheticSnapshot(360));

    // Still 150 — NOT 360 - 200 = 160, which is what a tail-relative count
    // would have produced, re-hiding turns 150..159.
    expect(hiddenAboveText()).toContain("150 earlier turns");
    expect(screen.getByText("turn-150 body")).toBeDefined();
    expect(screen.getByText("turn-359 body")).toBeDefined();
  });

  test("a full reveal survives the same session's transcript growing", () => {
    // The pre-existing PR #1667 R1 invariant, preserved: "show all" is now just
    // the index 0, so it holds for the same reason the partial case does.
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    fireEvent.click(screen.getByText("jump to the beginning"));
    expect(screen.getByText("turn-0 body")).toBeDefined();

    rerenderCV(syntheticSnapshot(180));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.getByText("turn-179 body")).toBeDefined();
    expect(hiddenAboveText()).toBeNull();
  });

  test("window resets to the tail when the session changes", () => {
    const { rerenderCV } = renderCV(syntheticSnapshot(120));
    fireEvent.click(screen.getByText("jump to the beginning"));
    expect(screen.getByText("turn-0 body")).toBeDefined();

    const other = { ...syntheticSnapshot(120), agentSessionId: "agent-test-windowing-2" };
    rerenderCV(other);
    // New session → back to the clipped tail window.
    expect(screen.queryByText("turn-0 body")).toBeNull();
    expect(hiddenAboveText()).toContain("70 earlier turns");
  });
});

describe("ConversationView thread position readout (mt#3688)", () => {
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

  test("the unrendered region disappears once everything is revealed", () => {
    renderCV(syntheticSnapshot(200));
    fireEvent.click(screen.getByText("jump to the beginning"));
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
