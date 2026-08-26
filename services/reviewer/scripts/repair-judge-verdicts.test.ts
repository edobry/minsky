/**
 * Unit tests for the targeted judge-verdict repair (mt#4633).
 *
 * The live judge call is INJECTED (`SingleJudgeRunner`), so nothing here
 * patches a module the code reaches itself — the seam is a parameter, per
 * `testing-standards.mdc §Testable Design`. That also lets the idempotence
 * test assert something a mock-free design could not: that the runner is
 * never CALLED when there is nothing to repair.
 */

import { describe, expect, test } from "bun:test";

import type { CorpusRow } from "../src/eval-corpus";
import type { JudgeModelConfig, PerJudgeVerdict } from "../src/judge";
import {
  applyRepairs,
  isFailedJudge,
  parseArgs,
  planRepair,
  recomputeContaminatedIds,
  recomputeRow,
  repairArtifact,
  spliceJudge,
  type RepairableArtifact,
  type SingleJudgeRunner,
  type StoredPerJudge,
} from "./repair-judge-verdicts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(id: string): CorpusRow {
  return {
    id,
    corpusVersion: "v1",
    source: "git-diff-mined",
    prNumber: 1942,
    round: 3,
    finding: { file: "src/foo.ts", severity: "BLOCKING", text: "a finding" },
    codeContextWindow: "const x = 1;",
    label: { value: "git-diff-fixed", provenance: "deterministic", confidence: "noisy-positive" },
    minedAt: "2026-08-25T00:00:00.000Z",
  };
}

const GOOD: StoredPerJudge = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  verdict: "NOISE",
  rationale: "The finding's premise is wrong for PostgreSQL.",
};

const FAILED: StoredPerJudge = {
  provider: "openai",
  model: "gpt-5",
  verdict: "VALID",
  rationale: "(judge call failed)",
  parseError: "judge call error: Operation timed out after 120000ms",
};

function makeArtifact(overrides: Partial<RepairableArtifact> = {}): RepairableArtifact {
  return {
    corpusVersion: "v1",
    candidateCount: 114,
    judgedCount: 114,
    disagreementCount: 2,
    panel: ["openai:gpt-5", "anthropic:claude-sonnet-4-6"],
    selectedIds: ["row-a", "row-b"],
    judgeVerdicts: {
      "row-a": { aggregate: "NOISE", agreement: false, perJudge: [FAILED, GOOD] },
      "row-b": { aggregate: "VALID", agreement: true, perJudge: [{ ...GOOD, verdict: "VALID" }] },
    },
    contaminatedIds: ["row-a"],
    ...overrides,
  };
}

/** A runner that always succeeds, and counts how many times it was called. */
function countingRunner(verdict: PerJudgeVerdict["verdict"] = "BUG_HIT") {
  const calls: { rowId: string; config: JudgeModelConfig }[] = [];
  const run: SingleJudgeRunner = async (row, config) => {
    calls.push({ rowId: row.id, config });
    return {
      provider: config.provider,
      model: config.model,
      verdict,
      rationale: "a fresh judgment",
    };
  };
  return { run, calls };
}

const alwaysHasKey = async () => "sk-test-not-a-real-key";

/**
 * Read a row's stored verdict, failing the test with a useful message rather
 * than a non-null assertion (`no-non-null-assertion` is an error here, and a
 * bare `!` would report `undefined is not an object` on a real regression).
 */
function storedRow(artifact: RepairableArtifact, rowId: string) {
  const stored = artifact.judgeVerdicts[rowId];
  if (stored === undefined) throw new Error(`no stored verdict for ${rowId}`);
  return stored;
}

// ---------------------------------------------------------------------------

describe("isFailedJudge / planRepair", () => {
  test("a per-judge entry is contaminated iff it carries a non-empty parseError", () => {
    expect(isFailedJudge(FAILED)).toBe(true);
    expect(isFailedJudge(GOOD)).toBe(false);
    expect(isFailedJudge({ ...GOOD, parseError: "" })).toBe(false);
  });

  test("defaults to the artifact's own contaminatedIds and targets only failed slots", () => {
    const targets = planRepair(makeArtifact());
    expect(targets).toHaveLength(1);
    expect(targets[0]?.rowId).toBe("row-a");
    expect(targets[0]?.failedJudges).toEqual([{ provider: "openai", model: "gpt-5", index: 0 }]);
  });

  test("--only narrows the set, and a clean row yields no target rather than an error", () => {
    const artifact = makeArtifact({ contaminatedIds: ["row-a"] });
    expect(planRepair(artifact, ["row-b"])).toHaveLength(0);
    expect(planRepair(artifact, ["row-a", "row-b"])).toHaveLength(1);
    expect(planRepair(artifact, ["row-does-not-exist"])).toHaveLength(0);
  });
});

describe("recomputeRow", () => {
  test("recomputes the aggregate and unanimity from the per-judge set", () => {
    expect(recomputeRow([GOOD, { ...GOOD, verdict: "NOISE" }])).toEqual({
      aggregate: "NOISE",
      agreement: true,
    });
    expect(
      recomputeRow([
        { ...GOOD, verdict: "BUG_HIT" },
        { ...GOOD, verdict: "BUG_HIT" },
      ])
    ).toEqual({ aggregate: "BUG_HIT", agreement: true });
    expect(
      recomputeRow([
        { ...GOOD, verdict: "BUG_HIT" },
        { ...GOOD, verdict: "NOISE" },
      ]).agreement
    ).toBe(false);
  });

  test("an EMPTY panel throws rather than recording vacuous unanimity (R1)", () => {
    // `[].every(...)` is vacuously true, so an unguarded implementation would
    // record `agreement: true` for a row judged by nobody — the same shape of
    // silent lie this task exists to repair.
    expect(() => recomputeRow([])).toThrow(/empty per-judge panel/);
  });
});

describe("spliceJudge", () => {
  test("replaces by INDEX, so a two-member same-provider panel is not cross-written", () => {
    const untouched: StoredPerJudge = { ...FAILED, model: "gpt-5" };
    const panel: StoredPerJudge[] = [untouched, { ...FAILED, model: "gpt-5-mini" }];
    const replacement: StoredPerJudge = {
      provider: "openai",
      model: "gpt-5-mini",
      verdict: "NOISE",
      rationale: "fresh",
    };
    const next = spliceJudge(panel, 1, replacement);
    expect(next[0]).toEqual(untouched);
    expect(next[1]).toEqual(replacement);
  });
});

describe("applyRepairs / recomputeContaminatedIds", () => {
  test("a row whose fresh verdict still fails stays in contaminatedIds", () => {
    const artifact = makeArtifact();
    const stillFailing: StoredPerJudge[] = [{ ...FAILED, parseError: "still timing out" }, GOOD];
    const next = applyRepairs(artifact, new Map([["row-a", stillFailing]]));
    expect(next.contaminatedIds).toEqual(["row-a"]);
  });

  test("a row that repaired cleanly leaves contaminatedIds", () => {
    const artifact = makeArtifact();
    const clean: StoredPerJudge[] = [
      { provider: "openai", model: "gpt-5", verdict: "NOISE", rationale: "fresh" },
      GOOD,
    ];
    const next = applyRepairs(artifact, new Map([["row-a", clean]]));
    expect(next.contaminatedIds).toEqual([]);
  });

  test("rows outside the repair set are carried through untouched", () => {
    const artifact = makeArtifact();
    const next = applyRepairs(artifact, new Map([["row-a", [GOOD, GOOD]]]));
    expect(storedRow(next, "row-b")).toEqual(storedRow(artifact, "row-b"));
  });
});

describe("repairArtifact", () => {
  test("AT4: the successful judge is carried through verbatim; only the failed one is replaced", async () => {
    const artifact = makeArtifact();
    const { run, calls } = countingRunner("NOISE");

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map([["row-a", makeRow("row-a")]]),
      alwaysHasKey,
      run
    );

    const perJudge = storedRow(outcome.artifact, "row-a").perJudge;
    // The already-successful entry is byte-identical, rationale included.
    expect(perJudge[1]).toEqual(GOOD);
    // The failed entry is replaced, and its parseError is gone.
    expect(perJudge[0]).toEqual({
      provider: "openai",
      model: "gpt-5",
      verdict: "NOISE",
      rationale: "a fresh judgment",
    });
    expect(perJudge[0]?.parseError).toBeUndefined();
    // Exactly one call, for exactly the failed slot's provider/model.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config.model).toBe("gpt-5");
    expect(outcome.attempted).toBe(1);
    expect(outcome.repaired).toBe(1);
  });

  test("AT5: an artifact with nothing contaminated makes ZERO judge calls", async () => {
    const artifact = makeArtifact({
      contaminatedIds: [],
      judgeVerdicts: {
        "row-a": { aggregate: "NOISE", agreement: true, perJudge: [GOOD, GOOD] },
      },
    });
    const { run, calls } = countingRunner();

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map([["row-a", makeRow("row-a")]]),
      alwaysHasKey,
      run
    );

    expect(calls).toHaveLength(0);
    expect(outcome.attempted).toBe(0);
    expect(outcome.artifact.judgeVerdicts).toEqual(artifact.judgeVerdicts);
  });

  test("AT3 (unit form): selectedIds and the run counts survive a repair unchanged", async () => {
    const artifact = makeArtifact();
    const { run } = countingRunner("NOISE");

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map([["row-a", makeRow("row-a")]]),
      alwaysHasKey,
      run
    );

    expect(outcome.artifact.selectedIds).toEqual(artifact.selectedIds);
    expect(outcome.artifact.corpusVersion).toBe(artifact.corpusVersion);
    expect(outcome.artifact.candidateCount).toBe(artifact.candidateCount);
    expect(outcome.artifact.judgedCount).toBe(artifact.judgedCount);
    expect(outcome.artifact.disagreementCount).toBe(artifact.disagreementCount);
    expect(outcome.artifact.panel).toEqual(artifact.panel);
  });

  test("the aggregate is recomputed from the repaired panel, not carried over", async () => {
    const artifact = makeArtifact();
    const { run } = countingRunner("BUG_HIT");

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map([["row-a", makeRow("row-a")]]),
      alwaysHasKey,
      run
    );

    // BUG_HIT (fresh) + NOISE (carried) is a 1-1 split; the stored aggregate
    // was NOISE and must not simply persist.
    const repairedRow = storedRow(outcome.artifact, "row-a");
    expect(repairedRow.agreement).toBe(false);
    expect(repairedRow.aggregate).toBe(recomputeRow(repairedRow.perJudge).aggregate);
  });

  test("a provider with no configured key is skipped and REPORTED, and the row stays contaminated", async () => {
    const artifact = makeArtifact();
    const { run, calls } = countingRunner();

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map([["row-a", makeRow("row-a")]]),
      async () => undefined,
      run
    );

    expect(calls).toHaveLength(0);
    expect(outcome.skippedNoKey).toEqual([{ rowId: "row-a", provider: "openai" }]);
    expect(outcome.artifact.contaminatedIds).toEqual(["row-a"]);
  });

  test("a target id absent from the corpus is REPORTED, not silently dropped", async () => {
    const artifact = makeArtifact();
    const { run, calls } = countingRunner();

    const outcome = await repairArtifact(
      artifact,
      planRepair(artifact),
      new Map(),
      alwaysHasKey,
      run
    );

    expect(calls).toHaveLength(0);
    expect(outcome.missingCorpusRows).toEqual(["row-a"]);
    expect(outcome.artifact.contaminatedIds).toEqual(["row-a"]);
  });

  test("R1: on an --only run, target-scoped and global failure counts are reported separately", async () => {
    // Two contaminated rows; only one is targeted. Reporting the GLOBAL count
    // as "rows still failing" would blame this run for a row it never tried.
    const artifact = makeArtifact({
      contaminatedIds: ["row-a", "row-b"],
      judgeVerdicts: {
        "row-a": { aggregate: "NOISE", agreement: false, perJudge: [FAILED, GOOD] },
        "row-b": { aggregate: "VALID", agreement: false, perJudge: [FAILED, GOOD] },
      },
    });
    const { run } = countingRunner("NOISE");
    const targets = planRepair(artifact, ["row-a"]);

    const outcome = await repairArtifact(
      artifact,
      targets,
      new Map([["row-a", makeRow("row-a")]]),
      alwaysHasKey,
      run
    );

    expect(outcome.repaired).toBe(1);
    expect(outcome.stillFailingInTargets).toBe(0);
    expect(outcome.stillFailingGlobal).toBe(1);
    expect(outcome.artifact.contaminatedIds).toEqual(["row-b"]);
  });
});

describe("recomputeContaminatedIds", () => {
  test("scans every row it is given, not only the ones that were repaired", () => {
    const verdicts = {
      "row-a": { aggregate: "NOISE" as const, agreement: true, perJudge: [GOOD] },
      "row-b": { aggregate: "VALID" as const, agreement: true, perJudge: [FAILED] },
    };
    expect(recomputeContaminatedIds(verdicts, ["row-a", "row-b"])).toEqual(["row-b"]);
  });
});

describe("parseArgs", () => {
  test("--only splits, trims, and drops empties", () => {
    expect(parseArgs(["--only", " a , b ,, c "]).onlyIds).toEqual(["a", "b", "c"]);
  });

  test("--dry-run defaults false and the paths default to the committed artifacts", () => {
    const args = parseArgs([]);
    expect(args.dryRun).toBe(false);
    expect(args.onlyIds).toBeUndefined();
    expect(args.artifactPath).toContain("judge-verdicts-v1.json");
    expect(args.corpusPath).toContain("ground-truth-v1.jsonl");
  });
});
