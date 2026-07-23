/**
 * Tests for the merge-time authorship-judging flag.
 *
 * The property under test is the DEFAULT: this gate encodes an operator
 * decision (ask#5581) that judging stays off, and mt#3101's repair would
 * otherwise have switched it on as a side effect. A gate that fails open is
 * worse than no gate — it would spend money per merge without anyone asking
 * for it.
 *
 * Reference: mt#3101 §Acceptance Tests
 */

import { describe, it, expect, afterEach } from "bun:test";

import {
  AUTHORSHIP_TIER_JUDGING_ENABLED_VALUE,
  AUTHORSHIP_TIER_JUDGING_ENV_VAR,
  isAuthorshipTierJudgingEnabled,
} from "./authorship-judging-flag";

const ORIGINAL = process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR];

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR];
  } else {
    process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] = ORIGINAL;
  }
});

describe("isAuthorshipTierJudgingEnabled", () => {
  it("is OFF when the variable is unset — the shipped default", () => {
    delete process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR];
    expect(isAuthorshipTierJudgingEnabled()).toBe(false);
  });

  it("is ON only for the exact enabling value", () => {
    process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] = AUTHORSHIP_TIER_JUDGING_ENABLED_VALUE;
    expect(isAuthorshipTierJudgingEnabled()).toBe(true);
  });

  it("fails CLOSED on a typo rather than enabling a per-merge AI call", () => {
    for (const value of ["enable", "ENABLED", "true", "1", "yes", "on", " enabled"]) {
      process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] = value;
      expect(isAuthorshipTierJudgingEnabled()).toBe(false);
    }
  });

  it("is OFF for an explicitly disabling value", () => {
    process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] = "disabled";
    expect(isAuthorshipTierJudgingEnabled()).toBe(false);
  });

  it("re-reads the environment on every call, so no restart is needed to flip it", () => {
    delete process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR];
    expect(isAuthorshipTierJudgingEnabled()).toBe(false);
    process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] = AUTHORSHIP_TIER_JUDGING_ENABLED_VALUE;
    expect(isAuthorshipTierJudgingEnabled()).toBe(true);
  });
});
