/**
 * Tests for usePrefersReducedMotion.ts (mt#3184).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { renderHook } from "@testing-library/react";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

function mockMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = [];
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (_query: string) => ({
      matches,
      addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {},
    }),
  });
  return listeners;
}

afterEach(() => {
  // @ts-expect-error test cleanup — restore to an unset state between tests
  delete window.matchMedia;
});

describe("usePrefersReducedMotion", () => {
  test("returns false when the media query does not match", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  test("returns true when the media query matches", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });
});
