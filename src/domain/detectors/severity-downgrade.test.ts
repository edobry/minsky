/**
 * Tests for severity-downgrade logic.
 *
 * Acceptance test AT3: 70% dismissal rate (7/10) → severity downgraded;
 *                      60% (6/10) → unchanged.
 *
 * Acceptance test AT4: version boundary — v1 dismissals don't affect v2 baseline.
 *                      (Callers must pass stats scoped to the correct version;
 *                       this test documents the structural isolation contract.)
 *
 * Reference: mt#1574 §Acceptance Tests
 */

import { describe, it, expect } from "bun:test";
import { computeEffectiveSeverity, DEFAULT_DOWNGRADE_THRESHOLD } from "./severity-downgrade";
import type { DismissalStats } from "./severity-downgrade";

const DETECTOR_ID = "policy-coverage";
const EVIDENCE_PATTERN = "Write::src/new-file.ts";

describe("computeEffectiveSeverity", () => {
  describe("AT3: 70% threshold behaviour", () => {
    it("downgrades medium to low when dismissal rate is exactly 70% (7/10)", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 7 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "medium", stats);
      expect(result).toBe("low");
    });

    it("downgrades high to low when dismissal rate is exactly 70%", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 7 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "high", stats);
      expect(result).toBe("low");
    });

    it("preserves medium severity when dismissal rate is 60% (6/10, below threshold)", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 6 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "medium", stats);
      expect(result).toBe("medium");
    });

    it("preserves high severity when dismissal rate is 60%", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 6 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "high", stats);
      expect(result).toBe("high");
    });

    it("downgrades when dismissal rate exceeds 70% (e.g. 8/10 = 80%)", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 8 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "medium", stats);
      expect(result).toBe("low");
    });

    it("preserves severity just below threshold (69%: 69/100)", () => {
      const stats: DismissalStats = { totalFirings: 100, dismissalCount: 69 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "medium", stats);
      expect(result).toBe("medium");
    });
  });

  describe("base severity interactions", () => {
    it("keeps low severity as low regardless of dismissal rate (already minimum)", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 10 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "low", stats);
      expect(result).toBe("low");
    });

    it("keeps low severity as low when dismissal rate is 0%", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 0 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "low", stats);
      expect(result).toBe("low");
    });
  });

  describe("zero-firing baseline", () => {
    it("returns base severity unchanged when totalFirings is 0 (no data yet)", () => {
      const stats: DismissalStats = { totalFirings: 0, dismissalCount: 0 };
      const resultMedium = computeEffectiveSeverity(
        DETECTOR_ID,
        "v1",
        EVIDENCE_PATTERN,
        "medium",
        stats
      );
      expect(resultMedium).toBe("medium");
    });

    it("returns high unchanged when totalFirings is 0", () => {
      const stats: DismissalStats = { totalFirings: 0, dismissalCount: 0 };
      const result = computeEffectiveSeverity(DETECTOR_ID, "v1", EVIDENCE_PATTERN, "high", stats);
      expect(result).toBe("high");
    });
  });

  describe("AT4: version boundary isolation", () => {
    it("v1 dismissal stats do not affect v2 severity when caller scopes stats correctly", () => {
      const v1Stats: DismissalStats = { totalFirings: 10, dismissalCount: 9 };
      const v2Stats: DismissalStats = { totalFirings: 0, dismissalCount: 0 };

      const v1Result = computeEffectiveSeverity(
        DETECTOR_ID,
        "v1",
        EVIDENCE_PATTERN,
        "medium",
        v1Stats
      );

      const v2Result = computeEffectiveSeverity(
        DETECTOR_ID,
        "v2",
        EVIDENCE_PATTERN,
        "medium",
        v2Stats
      );

      expect(v1Result).toBe("low");
      expect(v2Result).toBe("medium");
    });

    it("v2 with 0 firings gets fresh baseline even if v1 had 100% dismissal rate", () => {
      const v2Stats: DismissalStats = { totalFirings: 0, dismissalCount: 0 };

      const result = computeEffectiveSeverity(DETECTOR_ID, "v2", EVIDENCE_PATTERN, "high", v2Stats);

      expect(result).toBe("high");
    });

    it("v2 with its own dismissal history is independently calibrated", () => {
      const v2LowDismissalStats: DismissalStats = { totalFirings: 10, dismissalCount: 3 };

      const result = computeEffectiveSeverity(
        DETECTOR_ID,
        "v2",
        EVIDENCE_PATTERN,
        "medium",
        v2LowDismissalStats
      );

      expect(result).toBe("medium");
    });
  });

  describe("configurable threshold", () => {
    it("respects a custom threshold lower than the default", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 5 };
      const result = computeEffectiveSeverity(
        DETECTOR_ID,
        "v1",
        EVIDENCE_PATTERN,
        "medium",
        stats,
        { threshold: 0.5 }
      );
      expect(result).toBe("low");
    });

    it("respects a custom threshold higher than the default", () => {
      const stats: DismissalStats = { totalFirings: 10, dismissalCount: 7 };
      const result = computeEffectiveSeverity(
        DETECTOR_ID,
        "v1",
        EVIDENCE_PATTERN,
        "medium",
        stats,
        { threshold: 0.9 }
      );
      expect(result).toBe("medium");
    });
  });

  describe("DEFAULT_DOWNGRADE_THRESHOLD", () => {
    it("is 0.70", () => {
      expect(DEFAULT_DOWNGRADE_THRESHOLD).toBe(0.7);
    });
  });
});
