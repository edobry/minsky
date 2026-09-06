/**
 * mt#3376 — the live tail must not yank a reader's scroll position.
 *
 * Drives the real component through the `drivenBlocks` seam (the same seam the
 * live WS path feeds) and asserts the branch: pinned → follow the tail;
 * scrolled up → hold position and offer a way back.
 *
 * The scrollport's geometry is stubbed because happy-dom reports every element
 * as zero-height, which would make every case look "pinned" (nothing to
 * scroll) and silently pass regardless of the fix.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { resetScrollportGeometry } from "../lib/scrollport-test-state";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

function block(i: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `driven:turn:${i}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: new Date(Date.UTC(2026, 6, 30, 12, 0, i)).toISOString(),
    rawJsonlType: "assistant",
  };
}

function renderDriven(blocks: SessionContextSnapshotBlock[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationView drivenSessionId="scroll-test" drivenBlocks={blocks} />
    </QueryClientProvider>
  );
}

function rerenderDriven(
  rerender: (ui: React.ReactElement) => void,
  blocks: SessionContextSnapshotBlock[]
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rerender(
    <QueryClientProvider client={client}>
      <ConversationView drivenSessionId="scroll-test" drivenBlocks={blocks} />
    </QueryClientProvider>
  );
}

let scrollIntoView: ReturnType<typeof mock>;

/**
 * Give the resolved scrollport real geometry at `scrollTop`, then fire a scroll
 * so the component samples it.
 *
 * Targets `document.scrollingElement` deliberately: happy-dom lays every
 * element out at zero height, so no ancestor of the sentinel ever satisfies
 * `scrollHeight > clientHeight` and `findScrollParent` resolves to its
 * documented fallback. Stubbing a container instead would attach the geometry
 * to an element the component never listens on, and every case would read as
 * "pinned" — passing whether or not the fix works.
 */
function stubScrollport(scrollTop: number): HTMLElement {
  const port = document.scrollingElement as HTMLElement;
  Object.defineProperty(port, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(port, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(port, "scrollTop", {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(port);
  return port;
}

beforeEach(() => {
  scrollIntoView = mock(() => {});
  // happy-dom does not implement scrollIntoView; stubbing it is also how we
  // observe whether the component decided to scroll.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: scrollIntoView,
    writable: true,
    configurable: true,
  });
});

beforeEach(resetScrollportGeometry);
  afterEach(cleanup);

describe("ConversationView live tail — scroll pinning (mt#3376)", () => {
  test("scrolled up: a new live turn does NOT move the scroll position", () => {
    const { rerender } = renderDriven([block(0, "first"), block(1, "second")]);
    stubScrollport(0); // parked at the very top, reading history
    scrollIntoView.mockClear();

    rerenderDriven(rerender, [block(0, "first"), block(1, "second"), block(2, "third")]);

    expect(screen.getByText("third")).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test("scrolled up: the operator is told there is new content below", () => {
    const { rerender } = renderDriven([block(0, "first")]);
    stubScrollport(0);

    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
    rerenderDriven(rerender, [block(0, "first"), block(1, "second")]);

    expect(screen.getByTestId("jump-to-newest")).toBeDefined();
  });

  test("pinned to the bottom: a new live turn still scrolls into view", () => {
    const { rerender } = renderDriven([block(0, "first")]);
    stubScrollport(1600); // scrollHeight 2000 - clientHeight 400 == bottom
    scrollIntoView.mockClear();

    rerenderDriven(rerender, [block(0, "first"), block(1, "second")]);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });

  test("the return-to-newest control scrolls back and dismisses itself", () => {
    const { rerender } = renderDriven([block(0, "first")]);
    stubScrollport(0);
    rerenderDriven(rerender, [block(0, "first"), block(1, "second")]);
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByTestId("jump-to-newest"));

    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });

  test("scrolling back to the bottom by hand dismisses the control", () => {
    const { rerender } = renderDriven([block(0, "first")]);
    const port = stubScrollport(0);
    rerenderDriven(rerender, [block(0, "first"), block(1, "second")]);
    expect(screen.getByTestId("jump-to-newest")).toBeDefined();

    Object.defineProperty(port, "scrollTop", { value: 1600, writable: true, configurable: true });
    fireEvent.scroll(port);

    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });
});

/**
 * Stub the scrollport BEFORE the first render, so the growth baseline is
 * measured against real geometry.
 *
 * The suite above stubs after mounting, which is fine when the trigger is a
 * turn count — but these cases turn on a height DELTA, and a baseline taken at
 * happy-dom's zero height would make the very first stubbed measurement look
 * like growth no matter which direction the thread actually moved.
 */
function stubScrollportBeforeRender(scrollTop: number, scrollHeight = 2000): HTMLElement {
  const port = document.scrollingElement as HTMLElement;
  Object.defineProperty(port, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(port, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(port, "scrollTop", {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  return port;
}

function setScrollHeight(port: HTMLElement, value: number): void {
  Object.defineProperty(port, "scrollHeight", { value, configurable: true });
}

describe("ConversationView live tail — growth within one streaming turn (mt#3445)", () => {
  /**
   * The shape the accumulator actually produces mid-turn: the SAME block id
   * carrying more content, folded in via `upsertBlock`, so the array length
   * never moves. Keying the affordance on that length is the defect.
   */
  const streamingTurn = (text: string) => [block(0, "first"), block(1, text)];

  test("scrolled up: growth inside the turn already rendered surfaces the control", () => {
    const port = stubScrollportBeforeRender(0); // parked at the top, reading back
    const { rerender } = renderDriven(streamingTurn("partial"));
    fireEvent.scroll(port);
    scrollIntoView.mockClear();
    expect(screen.queryByTestId("jump-to-newest")).toBeNull();

    setScrollHeight(port, 2400);
    rerenderDriven(rerender, streamingTurn("partial, and then a great deal more of it"));

    expect(screen.getByTestId("jump-to-newest")).toBeDefined();
    // mt#3376's guarantee is not traded away to get the affordance.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test("pinned to the bottom: the same growth follows the tail and shows no control", () => {
    const port = stubScrollportBeforeRender(1600); // 2000 - 400 == the bottom
    const { rerender } = renderDriven(streamingTurn("partial"));
    fireEvent.scroll(port);
    scrollIntoView.mockClear();

    setScrollHeight(port, 2400);
    rerenderDriven(rerender, streamingTurn("partial, and then a great deal more of it"));

    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });

  test("a thread that gets SHORTER does not surface the control", () => {
    const port = stubScrollportBeforeRender(0);
    const { rerender } = renderDriven(streamingTurn("partial"));
    fireEvent.scroll(port);

    setScrollHeight(port, 1800);
    rerenderDriven(rerender, streamingTurn("partial"));

    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });

  test("growth with no content arrival does not surface the control", () => {
    // Expanding a tool block grows the thread by hundreds of pixels without
    // anything streaming in. Same array identity, taller thread, no affordance
    // — otherwise the reader's own click reports itself as "new messages".
    const port = stubScrollportBeforeRender(0);
    const unchanged = streamingTurn("partial");
    const { rerender } = renderDriven(unchanged);
    fireEvent.scroll(port);

    setScrollHeight(port, 2400);
    rerenderDriven(rerender, unchanged);

    expect(screen.queryByTestId("jump-to-newest")).toBeNull();
  });
});
