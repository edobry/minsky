/**
 * Tests for session-film-aliveness.ts (mt#3226 SC 4).
 */
import { describe, test, expect } from "bun:test";
import { bloomOpacity, bloomStdDeviation, computeGlowBrightness } from "./session-film-aliveness";
import { DEFAULT_SESSION_FILM_CONFIG } from "./session-film-config";

describe("computeGlowBrightness — continuous decay", () => {
  test("a touch at the current playhead moment is at full brightness", () => {
    const brightness = computeGlowBrightness(
      "2026-07-24T00:00:00.000Z",
      "2026-07-24T00:00:00.000Z",
      DEFAULT_SESSION_FILM_CONFIG
    );
    expect(brightness).toBeCloseTo(1, 5);
  });

  test("brightness decays continuously (monotonically) as elapsed time grows — the scene cools, it doesn't snap", () => {
    const last = "2026-07-24T00:00:00.000Z";
    const b0 = computeGlowBrightness(last, "2026-07-24T00:00:01.000Z", DEFAULT_SESSION_FILM_CONFIG);
    const b1 = computeGlowBrightness(last, "2026-07-24T00:00:10.000Z", DEFAULT_SESSION_FILM_CONFIG);
    const b2 = computeGlowBrightness(last, "2026-07-24T00:01:00.000Z", DEFAULT_SESSION_FILM_CONFIG);
    const b3 = computeGlowBrightness(last, "2026-07-24T00:10:00.000Z", DEFAULT_SESSION_FILM_CONFIG);
    expect(b0).toBeGreaterThan(b1);
    expect(b1).toBeGreaterThan(b2);
    expect(b2).toBeGreaterThan(b3);
    expect(b3).toBeGreaterThanOrEqual(0);
  });

  test("an invalid timestamp degrades to zero brightness rather than throwing/NaN", () => {
    expect(
      computeGlowBrightness("not-a-date", "2026-07-24T00:00:00.000Z", DEFAULT_SESSION_FILM_CONFIG)
    ).toBe(0);
  });
});

describe("bloomStdDeviation / bloomOpacity", () => {
  test("brighter (more recently touched) nodes get a WIDER, more opaque halo", () => {
    const dim = bloomStdDeviation(0, DEFAULT_SESSION_FILM_CONFIG);
    const bright = bloomStdDeviation(1, DEFAULT_SESSION_FILM_CONFIG);
    expect(bright).toBeGreaterThan(dim);

    expect(bloomOpacity(1)).toBeGreaterThan(bloomOpacity(0));
  });

  test("even a fully idle (brightness=0) node keeps a nonzero halo — never a hard on/off snap", () => {
    expect(bloomStdDeviation(0, DEFAULT_SESSION_FILM_CONFIG)).toBeGreaterThan(0);
    expect(bloomOpacity(0)).toBeGreaterThan(0);
  });
});
