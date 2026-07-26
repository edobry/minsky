/**
 * Tests for useAmbientClock.ts (mt#3226 SC 4).
 */
import { describe, test, expect } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useAmbientClock } from "./useAmbientClock";

describe("useAmbientClock — disabled", () => {
  test("returns baseIso unchanged, with no ticking, when disabled", () => {
    const { result } = renderHook(() => useAmbientClock(false, 50, "2026-07-24T00:00:00.000Z"));
    expect(result.current).toBe("2026-07-24T00:00:00.000Z");
  });
});

describe("useAmbientClock — enabled, anchored to baseIso (not the real wall-clock date)", () => {
  test("stays close to baseIso immediately after mount, regardless of the real current date", () => {
    // baseIso is deliberately a HISTORICAL date, far from whenever this test
    // actually runs — a naive `new Date()`-anchored clock would report an
    // enormous elapsed time here; the anchored clock must not.
    const baseIso = "2020-01-01T00:00:00.000Z";
    const { result } = renderHook(() => useAmbientClock(true, 50, baseIso));
    const elapsedMs = Date.parse(result.current) - Date.parse(baseIso);
    expect(Math.abs(elapsedMs)).toBeLessThan(1000);
  });

  test("advances at real-time rate while enabled", async () => {
    const baseIso = "2020-01-01T00:00:00.000Z";
    const { result } = renderHook(() => useAmbientClock(true, 20, baseIso));
    const initial = Date.parse(result.current);
    await waitFor(
      () => {
        expect(Date.parse(result.current)).toBeGreaterThan(initial);
      },
      { timeout: 1000 }
    );
  });

  test("resyncs to a new baseIso when the caller's playhead moment changes", () => {
    const { result, rerender } = renderHook(
      ({ base }: { base: string }) => useAmbientClock(true, 50, base),
      {
        initialProps: { base: "2020-01-01T00:00:00.000Z" },
      }
    );
    rerender({ base: "2025-06-15T12:00:00.000Z" });
    const elapsedMs = Date.parse(result.current) - Date.parse("2025-06-15T12:00:00.000Z");
    expect(Math.abs(elapsedMs)).toBeLessThan(1000);
  });
});
