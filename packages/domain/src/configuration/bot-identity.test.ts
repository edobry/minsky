/**
 * Tests for bot-identity resolution (mt#2392).
 *
 * The resolver backs the merge-gate waiver logic in
 * `session-merge-operations.ts`, the reviewer-watch detector default, and the
 * check-run submitter. Coverage:
 *
 *   1. Slice-based unit tests — config → identity mapping, defaults, the
 *      explicitlyConfigured flag, whitespace handling.
 *   2. Composition test — the no-arg call (exactly what mergeSessionPr makes)
 *      reads the live config system: with a configured non-Minsky login the
 *      resolver returns it; this is the config-driven waiver-path identity.
 *   3. Defined-fallback test — with nothing configured the resolver returns
 *      Minsky's own App identities (the documented absent-bot behavior: the
 *      waiver stays Minsky-default-scoped and external projects fall back to
 *      standard branch-protection approvals until they configure their bots).
 */

import { describe, it, expect } from "bun:test";
import { resolveBotIdentities } from "./bot-identity";
import { BOT_IDENTITY_LOGIN, REVIEWER_BOT_LOGIN } from "../constants";
import { initializeConfiguration, CustomConfigFactory } from "./index";

// Non-Minsky fixture identities (an external project's hypothetical bots).
const ACME_IMPLEMENTER = "acme-implementer[bot]";
const ACME_REVIEWER = "acme-reviewer[bot]";

describe("resolveBotIdentities (slice-based)", () => {
  it("falls back to the Minsky constants when the slice is empty (defined absent-bot fallback)", () => {
    const resolved = resolveBotIdentities({});
    expect(resolved.botIdentityLogin).toBe(BOT_IDENTITY_LOGIN);
    expect(resolved.reviewerBotLogin).toBe(REVIEWER_BOT_LOGIN);
    expect(resolved.explicitlyConfigured).toBe(false);
  });

  it("returns the configured implementer login and flags explicit configuration", () => {
    const resolved = resolveBotIdentities({
      github: { botIdentityLogin: ACME_IMPLEMENTER },
    });
    expect(resolved.botIdentityLogin).toBe(ACME_IMPLEMENTER);
    expect(resolved.reviewerBotLogin).toBe(REVIEWER_BOT_LOGIN);
    expect(resolved.explicitlyConfigured).toBe(true);
  });

  it("returns the configured reviewer login and flags explicit configuration", () => {
    const resolved = resolveBotIdentities({
      reviewer: { botLogin: ACME_REVIEWER },
    });
    expect(resolved.botIdentityLogin).toBe(BOT_IDENTITY_LOGIN);
    expect(resolved.reviewerBotLogin).toBe(ACME_REVIEWER);
    expect(resolved.explicitlyConfigured).toBe(true);
  });

  it("returns both configured logins when both are set", () => {
    const resolved = resolveBotIdentities({
      github: { botIdentityLogin: ACME_IMPLEMENTER },
      reviewer: { botLogin: ACME_REVIEWER },
    });
    expect(resolved.botIdentityLogin).toBe(ACME_IMPLEMENTER);
    expect(resolved.reviewerBotLogin).toBe(ACME_REVIEWER);
    expect(resolved.explicitlyConfigured).toBe(true);
  });

  it("treats whitespace-only configured values as absent", () => {
    const resolved = resolveBotIdentities({
      github: { botIdentityLogin: "   " },
      reviewer: { botLogin: "" },
    });
    expect(resolved.botIdentityLogin).toBe(BOT_IDENTITY_LOGIN);
    expect(resolved.reviewerBotLogin).toBe(REVIEWER_BOT_LOGIN);
    expect(resolved.explicitlyConfigured).toBe(false);
  });

  it("never throws and never returns empty identities (merge must not crash on identity resolution)", () => {
    // No-arg call in an arbitrary test context: config may or may not be
    // initialized — either way the resolver degrades to non-empty identities.
    const resolved = resolveBotIdentities();
    expect(resolved.botIdentityLogin.length).toBeGreaterThan(0);
    expect(resolved.reviewerBotLogin.length).toBeGreaterThan(0);
  });
});

describe("resolveBotIdentities (through the live config system)", () => {
  it("the no-arg call (as made by mergeSessionPr) returns configured non-Minsky logins", async () => {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      overrides: {
        github: { botIdentityLogin: "external-impl[bot]" },
        reviewer: { botLogin: "external-reviewer[bot]" },
      },
      skipValidation: true,
    });

    const resolved = resolveBotIdentities();
    expect(resolved.botIdentityLogin).toBe("external-impl[bot]");
    expect(resolved.reviewerBotLogin).toBe("external-reviewer[bot]");
    expect(resolved.explicitlyConfigured).toBe(true);

    // Restore an unconfigured state so this file doesn't leak custom
    // identities into other tests running in the same process.
    await initializeConfiguration(factory, {
      overrides: {},
      skipValidation: true,
    });
    const restored = resolveBotIdentities();
    expect(restored.botIdentityLogin).toBe(BOT_IDENTITY_LOGIN);
    expect(restored.reviewerBotLogin).toBe(REVIEWER_BOT_LOGIN);
  });
});
