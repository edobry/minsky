/**
 * The thread's bottom-edge footer as ONE stack (mt#3843).
 *
 * Three controls used to pin themselves to the bottom of the scrollport
 * independently — the position pill and the return-to-newest button from inside
 * `ConversationView`, and the host's activity strip mounted as a SIBLING of it —
 * all at `sticky ... z-10` in one stacking context. Paint order was therefore
 * DOM order, and the host's strip (last, opaque, full-width) covered the pill
 * and took the click meant for its "↑ start" button.
 *
 * What is asserted here is STRUCTURE: that everything pinned to the bottom edge
 * goes through a single container, and that no member pins itself. That is the
 * property which makes the stacking correct, and it is checkable without a
 * layout engine.
 *
 * What is deliberately NOT here is the GEOMETRY — whether the rects actually
 * stop overlapping, and whether `↑ start` is hit-testable. The component suite
 * runs under happy-dom, which has no layout engine: `getBoundingClientRect()`
 * returns all-zero and `elementFromPoint` cannot discriminate, so a rect
 * assertion written here would pass whether or not the bug were fixed
 * (`src/cockpit/CLAUDE.md` §Asserting layout geometry). Those live in
 * `scripts/verify-conversation-footer-stack.ts`, which drives a real browser
 * over CDP.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import { INITIAL_TURNS } from "../hooks/useThreadWindow";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

/** Stands in for the host's activity strip; identity is all these tests need. */
const TAIL = <div data-testid="test-tail">Running some_tool · 12s</div>;

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function turnBlock(i: number, role: "user" | "assistant"): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: `turn-${i} body` },
    timestamp: new Date(Date.UTC(2026, 7, 8, 12, 0, i)).toISOString(),
    turnIndex: i,
    rawJsonlType: role,
  };
}

function syntheticSnapshot(turnCount: number): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [];
  for (let i = 0; i < turnCount; i++) {
    blocks.push(turnBlock(i, i % 2 === 0 ? "user" : "assistant"));
  }
  return {
    agentSessionId: "agent-test-footer",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-08T12:00:00.000Z",
  };
}

function renderCV(turnCount: number, tail?: React.ReactNode) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ConversationView snapshot={syntheticSnapshot(turnCount)} tail={tail} />
    </QueryClientProvider>
  );
}

/** Long enough that the window engages and the position pill renders. */
const LONG = INITIAL_TURNS + 4;
/** Short enough that the pill is deliberately absent. */
const SHORT = 3;

afterEach(cleanup);

describe("mt#3843 — one sticky footer, not three competitors", () => {
  test("the host's tail and the position pill share ONE pinned container", () => {
    renderCV(LONG, TAIL);

    const footer = screen.getByTestId("thread-footer");
    const tail = screen.getByTestId("test-tail");
    const pill = screen.getByTestId("thread-position");

    // The regression this closes: the tail was a SIBLING of the thread, so the
    // two pinned themselves separately into the same band. Both inside one
    // container is what makes them stack instead of overlap.
    expect(footer.contains(tail)).toBe(true);
    expect(footer.contains(pill)).toBe(true);

    // The container is the only thing that pins.
    expect(footer.className).toContain("sticky");
    expect(footer.className).toContain("bottom-0");
    expect(pill.className).not.toContain("sticky");
  });

  test("the pill is ordered ABOVE the tail, so the opaque strip cannot cover it", () => {
    renderCV(LONG, TAIL);

    const pill = screen.getByTestId("thread-position");
    const tail = screen.getByTestId("test-tail");

    // DOCUMENT_POSITION_FOLLOWING: the tail comes after the pill in document
    // order, which in a flex column is below it. Asserted as order rather than
    // as coordinates because order is what the fix establishes — the previous
    // arrangement had the same order and still overlapped, because each element
    // pinned itself independently of the other.
    expect(pill.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the tail renders exactly once", () => {
    renderCV(LONG, TAIL);
    expect(screen.getAllByTestId("test-tail")).toHaveLength(1);
  });

  test("no footer is rendered when there is nothing to put in it", () => {
    // Short thread (no pill), nothing arrived from below (no return-to-newest),
    // no tail. An empty sticky box would still claim the band AND still eat
    // clicks aimed at the transcript underneath it.
    renderCV(SHORT);
    expect(screen.queryByTestId("thread-footer")).toBeNull();
  });

  test("a tail alone still gets a footer, even below the pill's turn threshold", () => {
    renderCV(SHORT, TAIL);

    expect(screen.queryByTestId("thread-position")).toBeNull();
    const footer = screen.getByTestId("thread-footer");
    expect(footer.contains(screen.getByTestId("test-tail"))).toBe(true);
  });

  test("an empty transcript still shows the tail", () => {
    // A transcript is ingested when the harness session ENDS, so a conversation
    // that is running right now routinely has no turns at all — which is
    // exactly when "Running <tool>" is the most informative thing on screen.
    // Before the tail became a prop the host rendered it as a sibling, so it
    // appeared here; routing it through the thread must not drop it.
    renderCV(0, TAIL);
    expect(screen.getByTestId("test-tail")).toBeTruthy();
  });
});
