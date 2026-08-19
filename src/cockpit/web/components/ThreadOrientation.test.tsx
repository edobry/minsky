/**
 * Thread orientation chrome (mt#3688).
 *
 * `ThreadStartBoundary` is exercised directly rather than through
 * `ConversationView` because one of its three states — the reveal in progress —
 * is not observable from the outside: the reveal runs inside a React transition,
 * and `act()` flushes that within the click that starts it, so a thread-level
 * test can never catch the thread mid-reveal. Rendering the component with the
 * state it is meant to display is the only way to assert what it displays.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThreadStartBoundary } from "./ThreadOrientation";

const noop = () => {};

function renderBoundary(props: Partial<Parameters<typeof ThreadStartBoundary>[0]> = {}) {
  return render(
    <ThreadStartBoundary
      hiddenBefore={0}
      isRevealing={false}
      revealingCount={0}
      firstTurnAt={undefined}
      onRevealOlder={noop}
      onRevealFromStart={noop}
      {...props}
    />
  );
}

describe("ThreadStartBoundary (mt#3688)", () => {
  afterEach(cleanup);

  test("the reveal-in-progress state NAMES how many turns are mounting", () => {
    // The count is the informative half: it separates "one chunk is mounting"
    // from "the whole transcript is mounting", which are very different waits.
    renderBoundary({ isRevealing: true, revealingCount: 100, hiddenBefore: 250 });
    expect(screen.getByTestId("thread-revealing").textContent).toContain(
      "Revealing 100 older turns"
    );
  });

  test("a one-turn reveal is not pluralised", () => {
    renderBoundary({ isRevealing: true, revealingCount: 1, hiddenBefore: 1 });
    expect(screen.getByTestId("thread-revealing").textContent).toContain("Revealing 1 older turn…");
  });

  test("the reveal state wins over the hidden-count state", () => {
    // Both are true mid-reveal (the count has not committed yet). Rendering the
    // count there would say "250 earlier turns" while 100 of them are actively
    // arriving, which is the ambiguity this boundary exists to remove.
    renderBoundary({ isRevealing: true, revealingCount: 100, hiddenBefore: 250 });
    expect(screen.queryByTestId("thread-hidden-above")).toBeNull();
    expect(screen.queryByTestId("thread-start")).toBeNull();
  });

  test("the hidden-count state offers both a chunk and a jump control", () => {
    // Scrolling reveals automatically; these are the fallback for a host where
    // the thread never overflows and there is no scroll to ride.
    let older = 0;
    let start = 0;
    renderBoundary({
      hiddenBefore: 250,
      onRevealOlder: () => (older += 1),
      onRevealFromStart: () => (start += 1),
    });
    expect(screen.getByTestId("thread-hidden-above").textContent).toContain("250 earlier turns");
    fireEvent.click(screen.getByText("show more"));
    fireEvent.click(screen.getByText("jump to the beginning"));
    expect(older).toBe(1);
    expect(start).toBe(1);
  });

  test("the beginning is named, and dated when the first turn has a timestamp", () => {
    renderBoundary({ hiddenBefore: 0, firstTurnAt: "2026-08-03T14:05:00.000Z" });
    const text = screen.getByTestId("thread-start").textContent ?? "";
    expect(text).toContain("Beginning of conversation");
    // The DAY, not the clock time: at a conversation boundary "when did this
    // start" is a date question, and the per-turn timestamps carry the rest.
    expect(text).toMatch(/Beginning of conversation — \w{3}, \w{3} \d+/);
  });

  test("the beginning still renders when the first turn has no usable timestamp", () => {
    // A degraded transcript must not lose its boundary — a missing date is a
    // smaller problem than a blank top of thread, which is the defect this
    // whole boundary exists to fix.
    renderBoundary({ hiddenBefore: 0, firstTurnAt: undefined });
    expect(screen.getByTestId("thread-start").textContent).toContain("Beginning of conversation");
  });
});

describe("ThreadStartBoundary — the fetch boundary (mt#4263)", () => {
  afterEach(cleanup);

  test("BLOCKING CASE: everything mounted but the server has more does NOT claim the beginning", () => {
    // The defect a server-side window would otherwise reintroduce, and the one
    // this component's own history is about: with `hiddenBefore` at 0 the old
    // three-state version said "Beginning of conversation" while 2,186 turns
    // sat unfetched — the same false picture mt#3688 removed, reached by a
    // different route.
    renderBoundary({ hiddenBefore: 0, unfetchedBefore: 2186, onLoadOlder: noop });
    expect(screen.queryByTestId("thread-start")).toBeNull();
    expect(screen.getByTestId("thread-unfetched-above").textContent).toContain(
      "2186 earlier turns not loaded"
    );
  });

  test("NEGATIVE CONTROL: with nothing unfetched the beginning still renders", () => {
    // Without this, the assertion above passes just as well against a component
    // that stopped rendering `thread-start` at all.
    renderBoundary({ hiddenBefore: 0, unfetchedBefore: 0, onLoadOlder: noop });
    expect(screen.getByTestId("thread-start").textContent).toContain("Beginning of conversation");
  });

  test("the load control asks the host to fetch", () => {
    let calls = 0;
    renderBoundary({
      hiddenBefore: 0,
      unfetchedBefore: 50,
      onLoadOlder: () => {
        calls += 1;
      },
    });
    fireEvent.click(screen.getByText("load earlier turns"));
    expect(calls).toBe(1);
  });

  test("a host that does not window never reaches the fetch state", () => {
    // `onLoadOlder` absent is how a caller holding the whole transcript is
    // distinguished — the share page and the publish preview both pass a
    // complete snapshot and must keep seeing the beginning.
    renderBoundary({ hiddenBefore: 0, unfetchedBefore: 2186 });
    expect(screen.getByTestId("thread-start")).toBeTruthy();
  });

  test("an in-flight FETCH is worded differently from an in-flight reveal", () => {
    // One is a round trip and the other is a render; a reader who sees the same
    // copy for both cannot tell a slow network from a slow mount.
    renderBoundary({ hiddenBefore: 0, unfetchedBefore: 50, isLoadingOlder: true, onLoadOlder: noop });
    expect(screen.getByTestId("thread-loading-older").textContent).toContain(
      "Loading earlier turns"
    );
  });

  test("mounting takes precedence over fetching when both are possible", () => {
    // `hiddenBefore > 0` means turns are already in memory; spending a round
    // trip before mounting what is already here would be strictly worse.
    renderBoundary({ hiddenBefore: 30, unfetchedBefore: 2186, onLoadOlder: noop });
    expect(screen.getByTestId("thread-hidden-above").textContent).toContain("30 earlier turns");
    expect(screen.queryByTestId("thread-unfetched-above")).toBeNull();
  });
});
