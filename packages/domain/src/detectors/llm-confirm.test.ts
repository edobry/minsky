/**
 * Rung-3 confirm-stage tests (mt#3652).
 *
 * The port is injected as a plain object — no module patching (per
 * testing-standards §Testable Design; the collaborator is a handed-in
 * dependency, which is what makes these tests possible without spyOn).
 */
import { describe, test, expect } from "bun:test";
import {
  confirmNominations,
  __TEST_ONLY,
  type ConfirmCandidate,
  type ConfirmDeps,
} from "./llm-confirm";

const R1_CANDIDATE: ConfirmCandidate = {
  family: "R1",
  segment: "I reasoned from one glob instead of checking the pipeline.",
};
const R3_CANDIDATE: ConfirmCandidate = {
  family: "R3",
  segment: "Going forward I'll check the lint config first.",
};
const CANDIDATES: ConfirmCandidate[] = [R1_CANDIDATE, R3_CANDIDATE];

function depsReturning(payload: unknown): ConfirmDeps {
  return {
    completionService: {
      generateObject: async () => payload,
    },
  };
}

describe("confirmNominations", () => {
  test("empty candidate list short-circuits without a provider call", async () => {
    let called = false;
    const deps: ConfirmDeps = {
      completionService: {
        generateObject: async () => {
          called = true;
          return { verdicts: [] };
        },
      },
    };
    const result = await confirmNominations("some turn text", [], deps);
    expect(result.degraded).toBe(false);
    expect(result.confirmations).toEqual([]);
    expect(called).toBe(false);
  });

  test("an endorsed candidate becomes a confirmation carrying its segment", async () => {
    const result = await confirmNominations(
      "turn text",
      CANDIDATES,
      depsReturning({
        verdicts: [
          { family: "R1", isGenuineAdmission: true, rationale: "admits its own reasoning failed" },
          { family: "R3", isGenuineAdmission: false, rationale: "ordinary next-step narration" },
        ],
      })
    );
    expect(result.degraded).toBe(false);
    expect(result.confirmations).toEqual([
      {
        family: "R1",
        segment: R1_CANDIDATE.segment,
        rationale: "admits its own reasoning failed",
      },
    ]);
  });

  test("the model cannot ADD families — verdicts outside the candidate set are discarded", async () => {
    const result = await confirmNominations(
      "turn text",
      [R1_CANDIDATE],
      depsReturning({
        verdicts: [
          { family: "R5", isGenuineAdmission: true, rationale: "not nominated" },
          { family: "R1", isGenuineAdmission: true, rationale: "nominated" },
        ],
      })
    );
    expect(result.confirmations.map((c) => c.family)).toEqual(["R1"]);
  });

  test("duplicate verdicts for one family yield one confirmation", async () => {
    const result = await confirmNominations(
      "turn text",
      [R1_CANDIDATE],
      depsReturning({
        verdicts: [
          { family: "R1", isGenuineAdmission: true, rationale: "first" },
          { family: "R1", isGenuineAdmission: true, rationale: "second" },
        ],
      })
    );
    expect(result.confirmations.length).toBe(1);
    expect(result.confirmations[0]?.rationale).toBe("first");
  });

  test("a provider exception degrades as provider-error, never throws", async () => {
    const deps: ConfirmDeps = {
      completionService: {
        generateObject: async () => {
          throw new Error("api key rejected");
        },
      },
    };
    const result = await confirmNominations("turn text", CANDIDATES, deps);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("provider-error");
    expect(result.degradedDetail).toContain("api key rejected");
    expect(result.confirmations).toEqual([]);
  });

  test("a payload failing the verdict schema degrades as schema-mismatch", async () => {
    const result = await confirmNominations(
      "turn text",
      CANDIDATES,
      depsReturning({ nonsense: true })
    );
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("schema-mismatch");
  });

  test("a stalled provider degrades as timeout within the budget", async () => {
    const deps: ConfirmDeps = {
      completionService: {
        // Never resolves: if the race bound did not hold, this await would
        // hang and the suite's own test timeout would fail the test — the
        // test COMPLETING is the boundedness assertion.
        generateObject: () => new Promise(() => {}),
      },
    };
    const result = await confirmNominations("turn text", CANDIDATES, deps, { timeoutMs: 50 });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe("timeout");
  });

  test("turn text beyond the cap is truncated in the prompt", () => {
    const long = "x".repeat(__TEST_ONLY.MAX_TURN_CHARS + 500);
    const prompt = __TEST_ONLY.buildUserPrompt(long, [R1_CANDIDATE]);
    expect(prompt.length).toBeLessThan(long.length + 500);
    expect(prompt).toContain("…");
  });

  test("the prompt names each nominated family with its segment", () => {
    const prompt = __TEST_ONLY.buildUserPrompt("text", CANDIDATES);
    expect(prompt).toContain("R1: nominated on the segment");
    expect(prompt).toContain("R3: nominated on the segment");
  });
});
