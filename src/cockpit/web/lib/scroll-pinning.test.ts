/**
 * mt#3376 — the pinned-to-bottom decision.
 *
 * These are the two facts the live-tail effect branches on, so they are tested
 * directly rather than only through a rendered thread.
 */
import { beforeEach, describe, test, expect } from "bun:test";
import { resetScrollportGeometry } from "./scrollport-test-state";
import {
  findScrollParent,
  formatThreadPosition,
  hasGrown,
  isNearTop,
  isPinnedToBottom,
  PINNED_THRESHOLD_PX,
  scrollFraction,
  threadPositionFromScroll,
} from "./scroll-pinning";

// This file stamps geometry onto `document.scrollingElement` too, so it owes the
// same reset as its two siblings — establish the scrollport rather than inherit
// one, and do not leave ours for whoever runs next (mt#3575).
beforeEach(resetScrollportGeometry);

/** A minimal stand-in for the scroll geometry the helper reads. */
function scrollport(scrollTop: number, scrollHeight: number, clientHeight: number): Element {
  return { scrollTop, scrollHeight, clientHeight } as unknown as Element;
}

describe("isPinnedToBottom", () => {
  test("exactly at the bottom is pinned", () => {
    expect(isPinnedToBottom(scrollport(600, 1000, 400))).toBe(true);
  });

  test("within the threshold is still pinned", () => {
    // The view's own scrollIntoView parks the sentinel up to 32px short of the
    // true bottom (scroll-mb-8), so this case IS the common one right after an
    // auto-scroll — treating it as unpinned would break follow-the-tail.
    expect(isPinnedToBottom(scrollport(600 - PINNED_THRESHOLD_PX + 1, 1000, 400))).toBe(true);
  });

  test("beyond the threshold is not pinned", () => {
    expect(isPinnedToBottom(scrollport(600 - PINNED_THRESHOLD_PX - 1, 1000, 400))).toBe(false);
  });

  test("scrolled well up is not pinned", () => {
    expect(isPinnedToBottom(scrollport(0, 5000, 400))).toBe(false);
  });

  test("a scrollport with nothing to scroll is pinned by definition", () => {
    // No "up" exists for the operator to have scrolled to, so a short thread
    // must keep following the tail.
    expect(isPinnedToBottom(scrollport(0, 300, 400))).toBe(true);
  });

  test("a missing scrollport is pinned — never suppress the scroll on unknown geometry", () => {
    expect(isPinnedToBottom(null)).toBe(true);
  });

  test("the threshold exceeds the sentinel's designed 32px offset", () => {
    // If this ever drops to <= 32 the view would consider itself unpinned
    // immediately after its own auto-scroll (mt#3344's scroll-mb-8).
    expect(PINNED_THRESHOLD_PX).toBeGreaterThan(32);
  });
});

describe("hasGrown (mt#3445)", () => {
  test("a taller thread is growth", () => {
    expect(hasGrown(701, 924)).toBe(true);
  });

  test("a shorter thread is not growth", () => {
    // A window resize that reflows the thread wider makes it SHORTER; nothing
    // arrived below the reader, so the affordance must stay hidden.
    expect(hasGrown(924, 701)).toBe(false);
  });

  test("an unchanged height is not growth", () => {
    expect(hasGrown(701, 701)).toBe(false);
  });

  test("the first measurement is a baseline, not growth", () => {
    // Otherwise the affordance would appear on mount, before anything has
    // streamed at all.
    expect(hasGrown(null, 924)).toBe(false);
  });

  test("a baseline of zero still compares as a height", () => {
    // `null` means unmeasured; 0 means measured-and-empty. Conflating them
    // would swallow the first real growth in an empty thread.
    expect(hasGrown(0, 1)).toBe(true);
  });
});

describe("findScrollParent", () => {
  test("returns null-safe for a null element", () => {
    // document.scrollingElement in a DOM env, null otherwise — either way it
    // must not throw, since it runs from an effect on every window change.
    expect(() => findScrollParent(null)).not.toThrow();
  });

  /** A container styled `decl` with real overflow, holding a child sentinel. */
  function containerWith(decl: string): { container: HTMLElement; child: HTMLElement } {
    const container = document.createElement("div");
    container.setAttribute("style", decl);
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    const child = document.createElement("div");
    container.appendChild(child);
    document.body.appendChild(container);
    return { container, child };
  }

  test.each([
    ["overflow-y: auto", "overflow-y: auto"],
    ["overflow-y: scroll", "overflow-y: scroll"],
    ["overflow: auto (shorthand)", "overflow: auto"],
    // PR #2459 R1: the original detector checked the shorthand for `auto` only,
    // so a container declared `overflow: scroll` could go undetected while its
    // `auto` sibling was found.
    ["overflow: scroll (shorthand)", "overflow: scroll"],
  ])("detects a container declared %s", (_name, decl) => {
    const { container, child } = containerWith(decl);
    try {
      expect(findScrollParent(child)).toBe(container);
    } finally {
      container.remove();
    }
  });

  test("skips a container that does not scroll its overflow", () => {
    const { container, child } = containerWith("overflow: hidden");
    try {
      expect(findScrollParent(child)).not.toBe(container);
    } finally {
      container.remove();
    }
  });
});

describe("isNearTop (mt#3688)", () => {
  test("at the very top is near the top", () => {
    expect(isNearTop(scrollport(0, 5000, 400))).toBe(true);
  });

  test("the runway is one viewport, so it scales with the viewport", () => {
    // Same scrollTop, two window sizes: the tall one still has a screenful of
    // warning left and the short one does not. A fixed pixel threshold would
    // answer the same for both, which is the reason this is measured in
    // clientHeight.
    expect(isNearTop(scrollport(500, 5000, 800))).toBe(true);
    expect(isNearTop(scrollport(500, 5000, 400))).toBe(false);
  });

  test("exactly one viewport up is still within the runway", () => {
    expect(isNearTop(scrollport(400, 5000, 400))).toBe(true);
    expect(isNearTop(scrollport(401, 5000, 400))).toBe(false);
  });

  test("scrolled to the bottom of a long thread is not near the top", () => {
    expect(isNearTop(scrollport(4600, 5000, 400))).toBe(false);
  });

  test("a scrollport with nothing to scroll has no top to be near", () => {
    // The consumer primes its scroll listener with a direct call at scrollTop 0.
    // Answering `true` here would fire a reveal on mount for a thread the
    // operator never touched — the exact cost the render window exists to avoid.
    expect(isNearTop(scrollport(0, 300, 400))).toBe(false);
    expect(isNearTop(null)).toBe(false);
  });
});

describe("scrollFraction (mt#3688)", () => {
  test("top is 0 and bottom is 1", () => {
    expect(scrollFraction(scrollport(0, 1400, 400))).toBe(0);
    expect(scrollFraction(scrollport(1000, 1400, 400))).toBe(1);
  });

  test("halfway through the scrollable range is 0.5", () => {
    expect(scrollFraction(scrollport(500, 1400, 400))).toBe(0.5);
  });

  test("a scrollport with nothing to scroll reads as the end, not the start", () => {
    // The whole thread is visible, and the thread's resting position is its
    // newest turn — reporting 0 would render a short conversation as "you are
    // at the beginning" when the reader is equally at the end.
    expect(scrollFraction(scrollport(0, 300, 400))).toBe(1);
    expect(scrollFraction(null)).toBe(1);
  });

  test("overscroll is clamped rather than reported past the ends", () => {
    expect(scrollFraction(scrollport(-50, 1400, 400))).toBe(0);
    expect(scrollFraction(scrollport(9999, 1400, 400))).toBe(1);
  });
});

describe("threadPositionFromScroll (mt#3688)", () => {
  test("the top of the rendered content IS the first rendered turn", () => {
    // 250 hidden of 300: at the top of what is mounted the operator is at turn
    // 250, not turn 0 — which is the whole point of counting the hidden turns.
    expect(threadPositionFromScroll(0, 250, 300)).toBe(250);
  });

  test("the bottom is the last turn of the whole transcript", () => {
    expect(threadPositionFromScroll(1, 250, 300)).toBe(300);
  });

  test("the middle interpolates across the RENDERED turns only", () => {
    // 50 rendered turns spanning the scroll range: halfway is 25 in.
    expect(threadPositionFromScroll(0.5, 250, 300)).toBe(275);
  });

  test("a fully revealed transcript spans the whole range", () => {
    expect(threadPositionFromScroll(0, 0, 300)).toBe(0);
    expect(threadPositionFromScroll(0.5, 0, 300)).toBe(150);
    expect(threadPositionFromScroll(1, 0, 300)).toBe(300);
  });

  test("an empty transcript has no position", () => {
    expect(threadPositionFromScroll(0.5, 0, 0)).toBe(0);
  });
});

describe("formatThreadPosition (mt#3688)", () => {
  test("carries the tilde, because the middle of the range is an estimate", () => {
    // Turns are wildly different heights — a one-line prompt and an expanded
    // tool block are both one turn — so the readout must not present itself as
    // exact.
    expect(formatThreadPosition(275, 300)).toBe("~275 / 300");
  });
});
