/**
 * Config-fingerprint derivation (mt#4556).
 *
 * Covers the task's acceptance tests 2, 3 and the effort dimension of 1:
 * identical configuration produces byte-identical values, one flipped flag
 * produces a different value with the differing dimension readable, and the
 * effort recorded is the effort `providers.ts` would actually have sent.
 */

import { describe, test, expect } from "bun:test";
import {
  buildConfigFingerprint,
  fingerprintForReview,
  parseRecoveryFlag,
  RECOVERY_FLAG_ENV_VARS,
  CONFIG_FINGERPRINT_VERSION,
} from "./config-fingerprint";
import { resolveReasoningEffort, parseToolloopRetryEnabled } from "./providers";

/** A fully-explicit env with every flag off, so no test depends on process.env. */
function envWith(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {};
  for (const [, envVar] of RECOVERY_FLAG_ENV_VARS) base[envVar] = "false";
  base.REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT = "true";
  return { ...base, ...overrides };
}

const BASE_CONFIG = {
  provider: "openai",
  providerModel: "gpt-5",
  tier2Enabled: false,
} as const;

/** Read one dimension back out of a fingerprint — the SC5 property, exercised. */
function dimension(fingerprint: string, key: string): string | undefined {
  for (const part of fingerprint.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === key) return part.slice(eq + 1);
  }
  return undefined;
}

describe("parseRecoveryFlag", () => {
  // These are the exact tokens the six gates in review-worker.ts accepted as
  // an inline regex before they were routed through this function. If this
  // set changes, those gates change with it — which is the point of there
  // being one function.
  test.each(["true", "TRUE", "True", "1", "yes", "YES", "on", "ON", " on ", "\ton\n"])(
    "accepts %p",
    (raw) => {
      expect(parseRecoveryFlag(raw)).toBe(true);
    }
  );

  test.each([undefined, "", "  ", "false", "0", "no", "off", "onn", "yes please", "2"])(
    "rejects %p",
    (raw) => {
      expect(parseRecoveryFlag(raw)).toBe(false);
    }
  );
});

describe("parseToolloopRetryEnabled — a DIFFERENT rule, default ON", () => {
  test("defaults to true when unset", () => {
    expect(parseToolloopRetryEnabled(undefined)).toBe(true);
  });

  test("is stricter than the recovery-flag parse: 'yes' and 'on' do NOT enable it", () => {
    // Not a bug being codified — the two parses genuinely differ, which is why
    // the fingerprint calls each flag's own parser rather than one shared one.
    expect(parseToolloopRetryEnabled("yes")).toBe(false);
    expect(parseToolloopRetryEnabled("on")).toBe(false);
    expect(parseToolloopRetryEnabled("true")).toBe(true);
    expect(parseToolloopRetryEnabled("1")).toBe(true);
  });
});

describe("resolveReasoningEffort", () => {
  test("tools active resolves to low; no tools resolves to medium (mt#1232)", () => {
    expect(resolveReasoningEffort("openai", "gpt-5", true)).toBe("low");
    expect(resolveReasoningEffort("openai", "gpt-5", false)).toBe("medium");
  });

  test("a caller override wins on both paths (the mt#1131 retry)", () => {
    expect(resolveReasoningEffort("openai", "gpt-5", true, "high")).toBe("high");
    expect(resolveReasoningEffort("openai", "gpt-5", false, "low")).toBe("low");
  });

  test("null for a non-reasoning model — the API 400s on the parameter", () => {
    expect(resolveReasoningEffort("openai", "gpt-4o", true)).toBeNull();
    expect(resolveReasoningEffort("openai", "gpt-4o", true, "high")).toBeNull();
  });

  test("null for a non-OpenAI provider — no equivalent knob exists", () => {
    expect(resolveReasoningEffort("anthropic", "gpt-5", true)).toBeNull();
    expect(resolveReasoningEffort("google", "gpt-5", true)).toBeNull();
  });
});

describe("buildConfigFingerprint", () => {
  test("AT2: identical configuration produces a byte-identical value", () => {
    const a = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith(),
    });
    const b = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith(),
    });
    expect(a).toBe(b);
  });

  test("AT3: flipping ONE flag changes the value, and only that dimension", () => {
    const FLIPPED = "incremental_diff";
    const before = buildConfigFingerprint({
      ...BASE_CONFIG,
      model: BASE_CONFIG.providerModel,
      reasoningEffort: "low",
      env: envWith(),
    });
    const after = buildConfigFingerprint({
      ...BASE_CONFIG,
      model: BASE_CONFIG.providerModel,
      reasoningEffort: "low",
      env: envWith({ REVIEWER_INCREMENTAL_DIFF_ENABLED: "true" }),
    });

    expect(after).not.toBe(before);
    expect(dimension(before, FLIPPED)).toBe("off");
    expect(dimension(after, FLIPPED)).toBe("on");

    // Every OTHER dimension is unchanged — a fingerprint that moved two
    // dimensions on one flag flip would make a cohort split unreadable.
    const changed = before
      .split(";")
      .filter((part, i) => part !== after.split(";")[i])
      .map((part) => part.split("=")[0]);
    expect(changed).toEqual([FLIPPED]);
  });

  test("SC5: every dimension is recoverable from the stored value alone", () => {
    const fingerprint = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: true,
      reasoningEffort: "medium",
      env: envWith({ REVIEWER_REFUTATION_RECOVERY_ENABLED: "on" }),
    });

    expect(dimension(fingerprint, "provider")).toBe("openai");
    expect(dimension(fingerprint, "model")).toBe("gpt-5");
    expect(dimension(fingerprint, "tier2")).toBe("on");
    expect(dimension(fingerprint, "effort")).toBe("medium");
    expect(dimension(fingerprint, "refutation_recovery")).toBe("on");
    expect(dimension(fingerprint, "toolloop_retry")).toBe("on");
  });

  test("carries a version tag and every declared dimension, sorted", () => {
    const fingerprint = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith(),
    });

    const [version, ...pairs] = fingerprint.split(";");
    expect(version).toBe(CONFIG_FINGERPRINT_VERSION);

    const keys = pairs.map((p) => p.split("=")[0]);
    // Sorted, so construction order cannot change the value.
    expect(keys).toEqual([...keys].sort());
    // Every flag in the declared set is present. A flag added to the reviewer
    // and not to RECOVERY_FLAG_ENV_VARS would report two different arms as the
    // same one, which is the regression this assertion exists to catch.
    for (const [key] of RECOVERY_FLAG_ENV_VARS) expect(keys).toContain(key);
    expect(keys).toEqual(expect.arrayContaining(["provider", "model", "tier2", "effort"]));
  });

  test("construction order does not affect the value", () => {
    const forward = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith({
        REVIEWER_COMPOSITION_CONVERGENCE_ENABLED: "on",
        REVIEWER_STRUCTURAL_CLAIM_VERIFICATION_ENABLED: "on",
      }),
    });
    const reversed = buildConfigFingerprint({
      provider: "openai",
      model: "gpt-5",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith({
        REVIEWER_STRUCTURAL_CLAIM_VERIFICATION_ENABLED: "on",
        REVIEWER_COMPOSITION_CONVERGENCE_ENABLED: "on",
      }),
    });
    expect(forward).toBe(reversed);
  });

  test("a value carrying the delimiters cannot break the encoding", () => {
    const fingerprint = buildConfigFingerprint({
      provider: "openai",
      model: "weird;model=injected",
      tier2Enabled: false,
      reasoningEffort: "low",
      env: envWith(),
    });
    // Sanitized, so the pair count is unchanged and `model` reads back whole.
    expect(dimension(fingerprint, "model")).toBe("weird_model_injected");
    expect(fingerprint.split(";").filter((p) => p.startsWith("model=")).length).toBe(1);
  });
});

describe("fingerprintForReview", () => {
  test("a model-invoking review records the effort actually sent", () => {
    const withTools = fingerprintForReview(BASE_CONFIG, {
      toolUseActive: true,
      modelCalled: true,
      env: envWith(),
    });
    const withoutTools = fingerprintForReview(BASE_CONFIG, {
      toolUseActive: false,
      modelCalled: true,
      env: envWith(),
    });

    expect(dimension(withTools, "effort")).toBe("low");
    expect(dimension(withoutTools, "effort")).toBe("medium");
  });

  test("a pre-model skip path records effort=none — no call was made", () => {
    const skipped = fingerprintForReview(BASE_CONFIG, {
      toolUseActive: false,
      modelCalled: false,
      env: envWith(),
    });

    expect(dimension(skipped, "effort")).toBe("none");
    // The configuration dimensions are still recorded — the row says what the
    // reviewer was configured to do when it declined.
    expect(dimension(skipped, "model")).toBe("gpt-5");
    expect(dimension(skipped, "tier2")).toBe("off");
  });

  test("a non-OpenAI arm records effort=none even when the model call happened", () => {
    const anthropic = fingerprintForReview(
      { provider: "anthropic", providerModel: "claude-sonnet-5", tier2Enabled: false },
      { toolUseActive: true, modelCalled: true, env: envWith() }
    );
    expect(dimension(anthropic, "effort")).toBe("none");
    expect(dimension(anthropic, "provider")).toBe("anthropic");
  });

  test("the tier gate is a dimension: flipping it changes the arm", () => {
    const off = fingerprintForReview(BASE_CONFIG, {
      toolUseActive: true,
      modelCalled: true,
      env: envWith(),
    });
    const on = fingerprintForReview(
      { ...BASE_CONFIG, tier2Enabled: true },
      { toolUseActive: true, modelCalled: true, env: envWith() }
    );
    expect(on).not.toBe(off);
    expect(dimension(on, "tier2")).toBe("on");
  });
});
