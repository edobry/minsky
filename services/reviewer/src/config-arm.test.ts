import { describe, expect, test } from "bun:test";
import {
  applyArmToConfig,
  assignArm,
  EXPERIMENT_MODEL_ENV_VAR,
  foreignProviderFor,
  type ArmName,
} from "./config-arm";
import type { ReviewerConfig } from "./config";

const INCUMBENT_MODEL = "gpt-5";
const CANDIDATE_MODEL = "gpt-5.6-luna";

const baseConfig: ReviewerConfig = {
  appId: 1,
  privateKey: "fake-key",
  installationId: 1,
  webhookSecret: "fake-secret",
  provider: "openai",
  providerApiKey: "sk-fake",
  providerModel: INCUMBENT_MODEL,
  tier2Enabled: false,
  mcpUrl: undefined,
  mcpToken: undefined,
  port: 3000,
  logLevel: "info",
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

/** Env with an experiment configured. */
const experimentEnv: Record<string, string | undefined> = {
  [EXPERIMENT_MODEL_ENV_VAR]: CANDIDATE_MODEL,
};

/** Env with no experiment — the state this ships in. */
const noExperimentEnv: Record<string, string | undefined> = {};

describe("assignArm — inert until configured", () => {
  test("no experiment env var: every PR is the incumbent", () => {
    for (const prNumber of [1, 2, 3, 100, 3341, 3342]) {
      const assignment = assignArm(prNumber, baseConfig, noExperimentEnv);
      expect(assignment.arm).toBe("incumbent");
      expect(assignment.model).toBe(INCUMBENT_MODEL);
      expect(assignment.experimentActive).toBe(false);
    }
  });

  test.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["explicitly undefined", undefined],
  ])("%s is treated as no experiment", (_label, raw) => {
    const assignment = assignArm(2, baseConfig, { [EXPERIMENT_MODEL_ENV_VAR]: raw });
    expect(assignment.arm).toBe("incumbent");
    expect(assignment.model).toBe(INCUMBENT_MODEL);
    expect(assignment.experimentActive).toBe(false);
  });
});

describe("assignArm — parity split", () => {
  test("even PR numbers take the candidate model", () => {
    for (const prNumber of [0, 2, 100, 3342]) {
      const assignment = assignArm(prNumber, baseConfig, experimentEnv);
      expect(assignment.arm).toBe("candidate");
      expect(assignment.model).toBe(CANDIDATE_MODEL);
      expect(assignment.experimentActive).toBe(true);
    }
  });

  test("odd PR numbers keep the incumbent model", () => {
    for (const prNumber of [1, 3, 101, 3341]) {
      const assignment = assignArm(prNumber, baseConfig, experimentEnv);
      expect(assignment.arm).toBe("incumbent");
      expect(assignment.model).toBe(INCUMBENT_MODEL);
      expect(assignment.experimentActive).toBe(true);
    }
  });

  test("experimentActive distinguishes 'no experiment' from 'drew the incumbent'", () => {
    // Both return arm=incumbent; only the flag tells them apart, which is the
    // difference between "nothing is running" and "this PR is the control".
    expect(assignArm(3341, baseConfig, noExperimentEnv).experimentActive).toBe(false);
    expect(assignArm(3341, baseConfig, experimentEnv).experimentActive).toBe(true);
  });
});

describe("assignArm — the property the denominator depends on", () => {
  test("every round of the same PR resolves to the same arm", () => {
    // A PR is reviewed once per push — measured mean 1.94 rounds, max 13 —
    // each in a separate process. If rounds of one PR could land in different
    // arms, rounds-to-convergence and $/converged-PR would be uncomputable.
    // This asserts the stateless recomputation that prevents it.
    const prNumber = 3342;
    const arms = new Set<ArmName>();
    for (let round = 0; round < 13; round++) {
      arms.add(assignArm(prNumber, baseConfig, experimentEnv).arm);
    }
    expect(arms.size).toBe(1);
    expect([...arms][0]).toBe("candidate");
  });

  test("assignment reads nothing but the PR number and the env", () => {
    // Two configs differing in every field except providerModel must not
    // change which arm a PR lands in — the arm has to be recoverable from a
    // row without knowing what else was configured when it was written.
    const otherConfig: ReviewerConfig = {
      ...baseConfig,
      appId: 999,
      tier2Enabled: true,
      port: 9999,
      logLevel: "debug",
    };
    for (const prNumber of [3341, 3342]) {
      expect(assignArm(prNumber, otherConfig, experimentEnv).arm).toBe(
        assignArm(prNumber, baseConfig, experimentEnv).arm
      );
    }
  });

  test("splits a realistic PR range close to evenly", () => {
    // The principal authorized "roughly half" the traffic on the candidate.
    // Over a contiguous range of PR numbers, parity is exactly half.
    let candidates = 0;
    const total = 1000;
    for (let prNumber = 3000; prNumber < 3000 + total; prNumber++) {
      if (assignArm(prNumber, baseConfig, experimentEnv).arm === "candidate") candidates++;
    }
    expect(candidates).toBe(total / 2);
  });
});

describe("assignArm — inputs that cannot be a PR number", () => {
  test.each([
    ["negative", -1],
    ["non-integer", 3.5],
    ["NaN", Number.NaN],
  ])("%s falls back to the incumbent rather than throwing", (_label, prNumber) => {
    // This sits on the review path: a review that runs on the incumbent beats
    // a review that does not run.
    const assignment = assignArm(prNumber, baseConfig, experimentEnv);
    expect(assignment.arm).toBe("incumbent");
    expect(assignment.model).toBe(INCUMBENT_MODEL);
    // Still true — an experiment IS configured; this input just could not be
    // assigned. Reporting false here would hide a real misroute.
    expect(assignment.experimentActive).toBe(true);
  });
});

describe("foreignProviderFor", () => {
  test.each([
    ["gpt-5.6-luna", "google", "openai"],
    ["gpt-5", "anthropic", "openai"],
    ["claude-sonnet-4-6", "openai", "anthropic"],
    ["gemini-2.5-pro", "openai", "google"],
    ["o3-mini", "google", "openai"],
  ] as const)("%s under provider %s is detected as %s", (model, provider, expected) => {
    expect(foreignProviderFor(model, provider)).toBe(expected);
  });

  test.each([
    ["gpt-5.6-luna", "openai"],
    ["claude-sonnet-4-6", "anthropic"],
    ["gemini-2.5-pro", "google"],
  ] as const)("%s under its own provider %s is not foreign", (model, provider) => {
    expect(foreignProviderFor(model, provider)).toBeNull();
  });

  test("an unrecognized model name is not treated as foreign", () => {
    // The check is a denylist of known foreign families, not an allowlist of
    // valid models: a model family that ships tomorrow must not be rejected
    // because nobody has added its prefix here yet.
    expect(foreignProviderFor("some-future-openai-model", "openai")).toBeNull();
    expect(foreignProviderFor("some-future-openai-model", "google")).toBeNull();
  });

  test("detection is case-insensitive and ignores surrounding whitespace", () => {
    expect(foreignProviderFor("  GPT-5.6-Luna  ", "google")).toBe("openai");
  });
});

describe("assignArm — cross-vendor candidate is refused", () => {
  const crossVendorEnv: Record<string, string | undefined> = {
    [EXPERIMENT_MODEL_ENV_VAR]: "gpt-5.6-luna",
  };
  const googleConfig: ReviewerConfig = {
    ...baseConfig,
    provider: "google",
    providerModel: "gemini-2.5-pro",
  };

  test("keeps the incumbent for an even PR that would otherwise take the candidate", () => {
    // 3342 is even, so without the guard this PR would call the Google client
    // with an OpenAI model string and the review would fail.
    const assignment = assignArm(3342, googleConfig, crossVendorEnv);
    expect(assignment.arm).toBe("incumbent");
    expect(assignment.model).toBe("gemini-2.5-pro");
  });

  test("reports the refusal rather than failing silently", () => {
    const assignment = assignArm(3342, googleConfig, crossVendorEnv);
    expect(assignment.rejectedCandidate).toEqual({
      model: "gpt-5.6-luna",
      foreignProvider: "openai",
    });
    // experimentActive stays true: an experiment IS configured, it just cannot
    // run. Reporting false would make a misconfiguration look like "nothing
    // was set up", which is the state an operator would not investigate.
    expect(assignment.experimentActive).toBe(true);
  });

  test("refuses for odd PRs too, so the log fires regardless of which arm was drawn", () => {
    // An odd PR would keep the incumbent anyway, but the operator still needs
    // to learn the experiment is not running — and half the PRs being odd
    // would otherwise halve the chance of noticing.
    const assignment = assignArm(3341, googleConfig, crossVendorEnv);
    expect(assignment.rejectedCandidate?.foreignProvider).toBe("openai");
  });

  test("a same-vendor candidate is not refused", () => {
    const assignment = assignArm(3342, baseConfig, experimentEnv);
    expect(assignment.rejectedCandidate).toBeUndefined();
    expect(assignment.arm).toBe("candidate");
  });

  test("applyArmToConfig keeps the incumbent config on a refused candidate", () => {
    // The whole point: a misconfigured experiment must not reach the client.
    expect(applyArmToConfig(googleConfig, 3342, crossVendorEnv)).toBe(googleConfig);
  });
});

describe("applyArmToConfig", () => {
  test("substitutes only providerModel, leaving every other field identical", () => {
    const applied = applyArmToConfig(baseConfig, 3342, experimentEnv);
    expect(applied.providerModel).toBe(CANDIDATE_MODEL);
    expect({ ...applied, providerModel: INCUMBENT_MODEL }).toEqual(baseConfig);
  });

  test("returns the same object reference when no experiment is running", () => {
    // Identity, not equality: the no-experiment path must not even allocate,
    // and a caller can tell by reference that this module did not intervene.
    expect(applyArmToConfig(baseConfig, 3342, noExperimentEnv)).toBe(baseConfig);
  });

  test("returns the same object reference for a PR in the incumbent arm", () => {
    expect(applyArmToConfig(baseConfig, 3341, experimentEnv)).toBe(baseConfig);
  });

  test("returns the same object reference when the candidate equals the incumbent", () => {
    // A degenerate but reachable configuration: REVIEWER_EXPERIMENT_MODEL set
    // to the model already running. Both arms are then the same model, so
    // there is nothing to substitute.
    const applied = applyArmToConfig(baseConfig, 3342, {
      [EXPERIMENT_MODEL_ENV_VAR]: INCUMBENT_MODEL,
    });
    expect(applied).toBe(baseConfig);
  });
});
