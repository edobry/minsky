/**
 * Tests for stage-2 LLM cluster analysis (mt#3330).
 *
 * AT4 (partial — the run-level "error state, not clean success" behavior is
 * tested at the orchestration layer in toil-miner-tick.test.ts): a failing
 * cluster analysis must be RECORDED as an error outcome, never silently
 * dropped or treated the same as a completed result, and one cluster's
 * failure must not prevent the others in the batch from being analyzed
 * (per-cluster isolation — `CognitionProvider.performBatch` is
 * documented all-or-nothing, which is why this stage calls `.perform`
 * once per cluster instead).
 */

import { describe, test, expect } from "bun:test";
import { analyzeClusters } from "./cluster-analysis";
import { isClusterAnalysisError, type MinedCluster } from "./types";
import type { CognitionProvider, CognitionTask, CognitionResult } from "../cognition/types";

/** Capture the built task's userPrompt for direct assertions (mt#3429 SC3). */
function capturingProvider(): { provider: CognitionProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider: CognitionProvider = {
    async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
      prompts.push(task.userPrompt);
      return {
        kind: "completed",
        value: {
          proposedPrimitive: "a new tool",
          existingToolCoverage: "none found",
          alreadyCovered: false,
        } as unknown as T,
      };
    },
    async performBatch(): Promise<never> {
      throw new Error("unused in these tests");
    },
  };
  return { provider, prompts };
}

function cluster(signature: string, toolSequence: string[]): MinedCluster {
  return {
    signature,
    toolSequence,
    frequency: 5,
    sessionCount: 2,
    chainLength: toolSequence.length,
    score: 10,
    sampleRefs: [],
  };
}

function fakeProvider(
  behavior: (task: CognitionTask<unknown>) => "ok" | "throw" | "unavailable"
): CognitionProvider {
  return {
    async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
      const outcome = behavior(task as CognitionTask<unknown>);
      if (outcome === "throw") throw new Error(`provider failed for ${task.id}`);
      if (outcome === "unavailable")
        return { kind: "unavailable", reason: "no provider configured" };
      return {
        kind: "completed",
        value: {
          proposedPrimitive: "a new tool",
          existingToolCoverage: "none found",
          alreadyCovered: false,
        } as unknown as T,
      };
    },
    async performBatch(): Promise<never> {
      throw new Error("unused in these tests");
    },
  };
}

describe("analyzeClusters", () => {
  test("returns a completed analysis for a successful cluster", async () => {
    const provider = fakeProvider(() => "ok");
    const results = await analyzeClusters(provider, [cluster("sig-a", ["Read", "Edit"])]);
    const outcome = results.get("sig-a");
    expect(outcome).toBeDefined();
    expect(outcome && !isClusterAnalysisError(outcome)).toBe(true);
  });

  test("records a per-cluster error without throwing, and does not block other clusters", async () => {
    const provider = fakeProvider((task) => (task.id.includes("sig-bad") ? "throw" : "ok"));
    const results = await analyzeClusters(provider, [
      cluster("sig-bad", ["Read", "Edit"]),
      cluster("sig-good", ["Bash", "Agent"]),
    ]);

    const bad = results.get("sig-bad");
    const good = results.get("sig-good");
    expect(bad && isClusterAnalysisError(bad)).toBe(true);
    expect(good && !isClusterAnalysisError(good)).toBe(true);
  });

  test("treats a non-completed CognitionResult kind as an error outcome", async () => {
    const provider = fakeProvider(() => "unavailable");
    const results = await analyzeClusters(provider, [cluster("sig-a", ["Read"])]);
    const outcome = results.get("sig-a");
    expect(outcome && isClusterAnalysisError(outcome)).toBe(true);
  });

  test("returns an empty map for an empty cluster list", async () => {
    const provider = fakeProvider(() => "ok");
    const results = await analyzeClusters(provider, []);
    expect(results.size).toBe(0);
  });
});

describe("buildUserPrompt — representative samples (mt#3429 SC3)", () => {
  test("includes tool name + arg_fingerprint pairs for each sample, never raw arguments", async () => {
    const { provider, prompts } = capturingProvider();
    const withSamples: MinedCluster = {
      signature: "sig-a",
      toolSequence: ["Bash", "Bash"],
      frequency: 5,
      sessionCount: 2,
      chainLength: 2,
      score: 10,
      sampleRefs: [
        { sessionId: "s1", turnIndex: 0, argFingerprints: ["fp:git-status", "fp:git-diff"] },
      ],
    };

    await analyzeClusters(provider, [withSamples]);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Representative samples");
    expect(prompts[0]).toContain("Bash(fp:fp:git-status)");
    expect(prompts[0]).toContain("Bash(fp:fp:git-diff)");
    // Never a raw argument payload — only the tool name + fingerprint form.
    expect(prompts[0]).not.toContain("rawArgs");
  });

  test("omits the samples section entirely when no sampleRef carries a fingerprint", async () => {
    const { provider, prompts } = capturingProvider();
    const noSamples: MinedCluster = {
      signature: "sig-b",
      toolSequence: ["Read", "Edit"],
      frequency: 5,
      sessionCount: 2,
      chainLength: 2,
      score: 10,
      sampleRefs: [{ sessionId: "s1", turnIndex: 0 }],
    };

    await analyzeClusters(provider, [noSamples]);

    expect(prompts[0]).not.toContain("Representative samples");
  });

  test("flags a fingerprint-refined cluster explicitly in the prompt", async () => {
    const { provider, prompts } = capturingProvider();
    const refined: MinedCluster = {
      signature: "sig-refined",
      toolSequence: ["Bash", "Bash"],
      frequency: 30,
      sessionCount: 25,
      chainLength: 2,
      score: 30 * 25 * 2,
      sampleRefs: [],
      argFingerprintSequence: ["fp:git-status", "fp:git-diff"],
    };

    await analyzeClusters(provider, [refined]);

    expect(prompts[0]).toContain("FINGERPRINT-REFINED");
    expect(prompts[0]).toContain("fp:git-status");
  });
});
