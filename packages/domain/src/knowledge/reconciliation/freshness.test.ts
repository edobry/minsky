import { describe, it, expect } from "bun:test";
import { classifyFreshness } from "./freshness";

/** Produce an ISO timestamp `days` days before `now`. */
function daysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

const NOW = new Date("2024-06-01T12:00:00.000Z");

describe("classifyFreshness", () => {
  describe("default thresholds (agingDays=30, staleDays=90)", () => {
    it("returns 'fresh' for a document modified 1 day ago", () => {
      expect(classifyFreshness(daysAgo(1, NOW), undefined, NOW)).toBe("fresh");
    });

    it("returns 'fresh' for a document modified 29 days ago", () => {
      expect(classifyFreshness(daysAgo(29, NOW), undefined, NOW)).toBe("fresh");
    });

    it("returns 'aging' for a document modified 30.5 days ago", () => {
      // Just past the agingDays threshold
      expect(classifyFreshness(daysAgo(31, NOW), undefined, NOW)).toBe("aging");
    });

    it("returns 'aging' for a document modified 45 days ago", () => {
      expect(classifyFreshness(daysAgo(45, NOW), undefined, NOW)).toBe("aging");
    });

    it("returns 'stale' for a document modified 100 days ago", () => {
      expect(classifyFreshness(daysAgo(100, NOW), undefined, NOW)).toBe("stale");
    });

    it("returns 'stale' for a document modified 365 days ago", () => {
      expect(classifyFreshness(daysAgo(365, NOW), undefined, NOW)).toBe("stale");
    });
  });

  describe("custom thresholds", () => {
    it("uses custom agingDays", () => {
      // threshold: aging=7, stale=14
      expect(classifyFreshness(daysAgo(5, NOW), { agingDays: 7, staleDays: 14 }, NOW)).toBe(
        "fresh"
      );
      expect(classifyFreshness(daysAgo(10, NOW), { agingDays: 7, staleDays: 14 }, NOW)).toBe(
        "aging"
      );
      expect(classifyFreshness(daysAgo(20, NOW), { agingDays: 7, staleDays: 14 }, NOW)).toBe(
        "stale"
      );
    });

    it("respects partial override — only agingDays", () => {
      // Override only agingDays to 10; staleDays stays 90
      expect(classifyFreshness(daysAgo(15, NOW), { agingDays: 10 }, NOW)).toBe("aging");
      expect(classifyFreshness(daysAgo(95, NOW), { agingDays: 10 }, NOW)).toBe("stale");
    });

    it("respects partial override — only staleDays", () => {
      // Override only staleDays to 60; agingDays stays 30
      expect(classifyFreshness(daysAgo(45, NOW), { staleDays: 60 }, NOW)).toBe("aging");
      expect(classifyFreshness(daysAgo(65, NOW), { staleDays: 60 }, NOW)).toBe("stale");
    });
  });

  describe("edge cases", () => {
    it("handles a timestamp exactly at agingDays boundary as fresh (boundary is exclusive)", () => {
      // exactly 30 days: ageMs / msPerDay == 30.0 → NOT > 30 → fresh
      expect(classifyFreshness(daysAgo(30, NOW), undefined, NOW)).toBe("fresh");
    });

    it("handles a future lastModified as fresh", () => {
      const future = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
      expect(classifyFreshness(future, undefined, NOW)).toBe("fresh");
    });
  });
});
