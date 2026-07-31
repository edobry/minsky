/**
 * mt#3376 — the pinned-to-bottom decision.
 *
 * These are the two facts the live-tail effect branches on, so they are tested
 * directly rather than only through a rendered thread.
 */
import { describe, test, expect } from "bun:test";
import { findScrollParent, isPinnedToBottom, PINNED_THRESHOLD_PX } from "./scroll-pinning";

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

describe("findScrollParent", () => {
  test("returns null-safe for a null element", () => {
    // document.scrollingElement in a DOM env, null otherwise — either way it
    // must not throw, since it runs from an effect on every window change.
    expect(() => findScrollParent(null)).not.toThrow();
  });
});
