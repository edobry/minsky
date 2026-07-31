/**
 * Tests for fingerprint-refined clustering (mt#3429 SC2).
 *
 * AT1 (fixture): a planted repeated fingerprint-sequence inside a noisy
 * name-cluster produces the REFINED cluster once concentration crosses the
 * threshold. AT2 (fixture): a generic cluster below the distinctiveness
 * floor is excluded entirely (never proposed generically).
 */

import { describe, test, expect } from "bun:test";
import {
  refineCluster,
  DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD,
} from "./fingerprint-refinement";
import { computeClusterSignature, computeRefinedClusterSignature } from "./sequence-mining";
import type { MinedCluster } from "./types";

function cluster(overrides: Partial<MinedCluster> = {}): MinedCluster {
  const toolSequence = overrides.toolSequence ?? ["Bash", "Bash"];
  return {
    signature: computeClusterSignature(toolSequence),
    toolSequence,
    frequency: 100,
    sessionCount: 50,
    chainLength: toolSequence.length,
    score: 100 * 50 * toolSequence.length,
    sampleRefs: [],
    ...overrides,
  };
}

describe("refineCluster", () => {
  test("DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD is ~20% per spec", () => {
    expect(DEFAULT_FINGERPRINT_CONCENTRATION_THRESHOLD).toBe(0.2);
  });

  test("AT1: proposes the REFINED cluster when concentration crosses the threshold", () => {
    const c = cluster({
      frequency: 100,
      fingerprintProfile: {
        sequence: ["fp:git-status", "fp:git-diff"],
        frequency: 30, // 30% of 100 — above the default 20% threshold
        sessionCount: 25,
        concentration: 0.3,
        sampleRefs: [{ sessionId: "s1", turnIndex: 0 }],
      },
    });

    const outcome = refineCluster(c);

    expect(outcome.kind).toBe("refined");
    if (outcome.kind !== "refined") throw new Error("unreachable");
    expect(outcome.cluster.argFingerprintSequence).toEqual(["fp:git-status", "fp:git-diff"]);
    expect(outcome.cluster.frequency).toBe(30);
    expect(outcome.cluster.sessionCount).toBe(25);
    expect(outcome.cluster.signature).toBe(
      computeRefinedClusterSignature(c.toolSequence, ["fp:git-status", "fp:git-diff"])
    );
    expect(outcome.cluster.signature).not.toBe(c.signature);
    expect(outcome.concentration).toBeCloseTo(0.3);
  });

  test("AT2: excludes a generic cluster below the distinctiveness floor", () => {
    const c = cluster({
      frequency: 100,
      fingerprintProfile: {
        sequence: ["fp:a", "fp:b"],
        frequency: 5, // 5% — below the default 20% threshold
        sessionCount: 5,
        concentration: 0.05,
        sampleRefs: [],
      },
    });

    const outcome = refineCluster(c);

    expect(outcome.kind).toBe("excluded");
    expect(outcome.concentration).toBeCloseTo(0.05);
  });

  test("passes a cluster through unchanged when no fingerprintProfile was ever measured", () => {
    // Distinct from "excluded" — that's for MEASURED low concentration.
    // A cluster with NO measurement at all (e.g. an older/hand-built
    // MinedCluster) is not evidence of genericness; fail open.
    const c = cluster({ fingerprintProfile: undefined });
    const outcome = refineCluster(c);
    expect(outcome.kind).toBe("unrefined");
    if (outcome.kind !== "unrefined") throw new Error("unreachable");
    expect(outcome.cluster.signature).toBe(c.signature);
  });

  test("respects a configurable threshold", () => {
    const c = cluster({
      fingerprintProfile: {
        sequence: ["fp:a", "fp:b"],
        frequency: 25,
        sessionCount: 20,
        concentration: 0.25,
        sampleRefs: [],
      },
    });

    expect(refineCluster(c, 0.3).kind).toBe("excluded"); // 25% < 30% custom threshold
    expect(refineCluster(c, 0.2).kind).toBe("refined"); // 25% >= 20% default
  });

  test("treats exactly-at-threshold concentration as refined (inclusive boundary)", () => {
    const c = cluster({
      fingerprintProfile: {
        sequence: ["fp:a", "fp:b"],
        frequency: 20,
        sessionCount: 15,
        concentration: 0.2,
        sampleRefs: [],
      },
    });
    expect(refineCluster(c, 0.2).kind).toBe("refined");
  });
});
