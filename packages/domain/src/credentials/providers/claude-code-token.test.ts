import { describe, expect, test } from "bun:test";
import { claudeCodeTokenProvider } from "./claude-code-token";
import { getCredentialProvider, KNOWN_PROVIDER_IDS, listCredentialProviders } from "./index";

/** The provider id, shared so the registration assertions cannot drift apart. */
const PROVIDER_ID = "claude-code-token";

/** A plausible subscription token: long, and not API-key-shaped. */
const PLAUSIBLE_TOKEN = `oat-${"x".repeat(40)}`;

/** An Anthropic API key, which must be REJECTED here — see the billing tests. */
const API_KEY = `sk-ant-${"a".repeat(40)}`;

describe("registration", () => {
  test("is reachable by id, which is what `credentials add <id>` needs", () => {
    expect(getCredentialProvider(PROVIDER_ID)).toBe(claudeCodeTokenProvider);
  });

  test("is in KNOWN_PROVIDER_IDS", () => {
    expect(KNOWN_PROVIDER_IDS).toContain(PROVIDER_ID);
  });

  test("is listed, which is what makes it appear in the cockpit dialog", () => {
    // The cockpit reads GET /api/credentials/providers, which is backed by
    // listCredentialProviders(). Being in the REGISTRY is not sufficient — a
    // provider with an isAvailable() gate returning false is registered and
    // invisible. This asserts the property the UI actually depends on.
    const ids = listCredentialProviders().map((p) => p.id);
    expect(ids).toContain(PROVIDER_ID);
  });

  test("does not collide with the metered anthropic provider", () => {
    const anthropic = getCredentialProvider("anthropic");
    expect(anthropic?.configPath).toBe("ai.providers.anthropic.apiKey");
    expect(claudeCodeTokenProvider.configPath).toBe("ai.providers.anthropic.authToken");
    expect(claudeCodeTokenProvider.configPath).not.toBe(anthropic?.configPath);
  });
});

describe("the API-key paste is rejected — the one error with a billing consequence", () => {
  // Storing a metered API key here would silently bill API credits for every
  // run, which is exactly the distinction this provider exists to make.
  test("rejects an sk-ant- key and says why", async () => {
    const result = await claudeCodeTokenProvider.validate(API_KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("API key");
    expect(result.detail).toContain("anthropic");
  });

  test("names the remedy, not just the problem", async () => {
    const result = await claudeCodeTokenProvider.validate(API_KEY);
    expect(result.detail).toContain("claude setup-token");
  });

  test("test() rejects it too — both stages, not just the pre-store one", async () => {
    const result = await claudeCodeTokenProvider.test(API_KEY);
    expect(result.ok).toBe(false);
  });
});

describe("shape checks", () => {
  test("rejects empty", async () => {
    expect((await claudeCodeTokenProvider.validate("")).ok).toBe(false);
  });

  test("rejects whitespace-only, which trims to empty", async () => {
    expect((await claudeCodeTokenProvider.validate("   ")).ok).toBe(false);
  });

  test("rejects a truncated paste and reports the length it saw", async () => {
    const result = await claudeCodeTokenProvider.validate("abc123");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("6");
  });

  test("accepts a plausible token", async () => {
    expect((await claudeCodeTokenProvider.validate(PLAUSIBLE_TOKEN)).ok).toBe(true);
  });

  test("tolerates surrounding whitespace, which a paste routinely carries", async () => {
    expect((await claudeCodeTokenProvider.validate(`  ${PLAUSIBLE_TOKEN}\n`)).ok).toBe(true);
  });
});

describe("the success detail does not claim a validation that did not happen", () => {
  // This is the property the whole design rests on: an unvalidatable credential
  // and a validated one must not look alike to a reader of the output.
  test("says NOT checked, in the success path", async () => {
    const result = await claudeCodeTokenProvider.validate(PLAUSIBLE_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("NOT checked");
  });

  test("cites the task that owns adding the real check", async () => {
    const result = await claudeCodeTokenProvider.validate(PLAUSIBLE_TOKEN);
    expect(result.detail).toContain("mt#5022");
  });

  test("never reports an identity or a count, which would imply a live call", async () => {
    // The sibling anthropic provider returns "N models accessible" — a real
    // response. Anything shaped like that here would be a fabrication.
    const result = await claudeCodeTokenProvider.validate(PLAUSIBLE_TOKEN);
    expect(result.detail).not.toMatch(/\d+ model/);
    expect(result.detail).not.toContain("accessible");
  });

  test("never echoes the token itself into the detail string", async () => {
    // The detail is surfaced in the cockpit and the CLI, and both are
    // transcript-adjacent surfaces.
    const result = await claudeCodeTokenProvider.validate(PLAUSIBLE_TOKEN);
    expect(result.detail).not.toContain(PLAUSIBLE_TOKEN);
  });
});

describe("guidance", () => {
  test("names the acquisition command rather than only a URL", async () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("claude setup-token");
  });

  test("states the billing distinction, which is the reason to pick this provider", () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("SUBSCRIPTION");
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("API credits");
  });

  test("warns that the stored value is unverified", () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("not verified");
  });
});
