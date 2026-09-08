import { describe, expect, test } from "bun:test";
import { claudeCodeTokenProvider } from "./claude-code-token";
import { getCredentialProvider, KNOWN_PROVIDER_IDS, listCredentialProviders } from "./index";

/** The provider id, shared so the registration assertions cannot drift apart. */
const PROVIDER_ID = "claude-code-token";

/**
 * The command that mints a subscription token. Every message that refuses a
 * value should name it — telling the operator what is wrong without telling
 * them how to get the right thing is half an error message.
 */
const SETUP_TOKEN_COMMAND = "claude setup-token";

/**
 * The prefix a subscription token carries. Shared across the assertions so a
 * change to the accepted shape cannot leave some of them checking the old one.
 */
const SUBSCRIPTION_PREFIX = "sk-ant-oat";

/**
 * The phrase that makes an API-key refusal specific rather than generic. It is
 * the whole reason that branch exists, so the assertions share one spelling.
 */
const BILLING_CONSEQUENCE = "bill API credits";

/**
 * A REAL-shaped subscription token from `claude setup-token`.
 *
 * PROVENANCE (mem#968): the `sk-ant-oat01-` prefix is transcribed from the
 * operator's own `claude setup-token` output, observed in the cockpit, and
 * corroborated by `anthropics/claude-code-action` issue #1316
 * ("claude_code_oauth_token (sk-ant-oat01-*) fails with Header 14 invalid
 * value"). It is NOT recalled, and it is NOT derived from the source file's own
 * regex — deriving it from the code is what makes a fixture unfalsifiable.
 *
 * The original fixture was `"sk-ant-oat01-".replace("sk-ant-", "oat-")` — the
 * true prefix, rewritten so it would survive a check that rejected the whole
 * `sk-ant-` family. That edit is what let the first bug ship: a fixture reshaped
 * to pass cannot represent the input the code will actually see (mt#5023 SC5).
 */
const SUBSCRIPTION_TOKEN = `sk-ant-oat01-${"x".repeat(95)}`;

/** An Anthropic API key, which must be REJECTED — see the billing tests. */
const API_KEY = `sk-ant-api03-${"a".repeat(95)}`;

/**
 * An `sk-ant-` value matching neither known segment. Must be REJECTED.
 *
 * mt#5023 accepted this shape, reasoning that refusing a format Anthropic might
 * add is the same class of error as refusing `oat01` was. mt#5026 reversed it:
 * the family prefix is not a credential type, and this provider holds one type.
 */
const UNRECOGNIZED_SK_ANT_SHAPE = `sk-ant-future9-${"z".repeat(40)}`;

/**
 * What the operator actually typed into the cockpit dialog on 2026-09-07, which
 * mt#5023's build ACCEPTED and stored. The originating report for mt#5026.
 */
const GIBBERISH = "hello world this is not a token at all";

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
    expect(result.detail).toContain(SETUP_TOKEN_COMMAND);
  });

  test("test() rejects it too — both stages, not just the pre-store one", async () => {
    const result = await claudeCodeTokenProvider.test(API_KEY);
    expect(result.ok).toBe(false);
  });

  test("gets the BILLING message, not the generic shape one", async () => {
    // An API key is a recognized credential in the wrong place, so the ordering
    // of the two rejections is load-bearing: the operator needs to be told which
    // provider to use, not that their value is unrecognizable.
    const apiKey = await claudeCodeTokenProvider.validate(API_KEY);
    const gibberish = await claudeCodeTokenProvider.validate(GIBBERISH);
    expect(apiKey.detail).toContain(BILLING_CONSEQUENCE);
    expect(gibberish.detail).not.toContain(BILLING_CONSEQUENCE);
  });
});

describe("the segment discriminates, not the family prefix (mt#5023)", () => {
  // Both credentials start `sk-ant-`. Testing that prefix rejected every
  // subscription token — the first shipped bug, reported by the operator pasting
  // a real one. These are the regression.
  test("ACCEPTS a real sk-ant-oat01- subscription token", async () => {
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.ok).toBe(true);
  });

  test("still REJECTS an sk-ant-api03- API key", async () => {
    const result = await claudeCodeTokenProvider.validate(API_KEY);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("API key");
  });

  test("both share the sk-ant- prefix, which is why it cannot be the test", () => {
    expect(SUBSCRIPTION_TOKEN.startsWith("sk-ant-")).toBe(true);
    expect(API_KEY.startsWith("sk-ant-")).toBe(true);
  });

  test("tolerates a different VERSION within the same token kind", async () => {
    // `oat01` -> `oat02` is a version bump on the credential this provider
    // holds. That is the axis `\d+` exists for, and it is NOT the axis mt#5026
    // closed — a different SEGMENT is a different kind of credential.
    const result = await claudeCodeTokenProvider.validate(`sk-ant-oat02-${"x".repeat(95)}`);
    expect(result.ok).toBe(true);
  });

  test("REJECTS a version-LESS sk-ant-oat- , which no observed token has", async () => {
    // `\d*` would have accepted this. Tolerating a version bump is not the same
    // as tolerating no version at all: the second is a shape nobody has seen,
    // and the accept predicate is where loose is dangerous.
    const result = await claudeCodeTokenProvider.validate(`sk-ant-oat-${"x".repeat(95)}`);
    expect(result.ok).toBe(false);
  });

  test("a version-LESS sk-ant-api- still gets the BILLING message", async () => {
    // The mirror case, and the reason API_KEY_SEGMENT keeps `\d*` while the
    // subscription one takes `\d+`. This predicate picks which REFUSAL an
    // already-refused value gets, so a loose match can only improve the
    // message. Both are refused either way — that is what the second assertion
    // pins down, so the looseness cannot quietly become an acceptance.
    const result = await claudeCodeTokenProvider.validate(`sk-ant-api-${"a".repeat(95)}`);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(BILLING_CONSEQUENCE);
  });
});

describe("the length floor, which is checked only after the shape matches", () => {
  // The floor is 60: `sk-ant-oat01-` (13) plus roughly half the 95-char body of
  // the only token length ever observed. These lock both sides of it so a
  // future edit cannot drift the floor without a test saying so.
  const PREFIX = "sk-ant-oat01-";

  test("REJECTS the reviewer's case — correct shape, 20 chars total", async () => {
    const token = `${PREFIX}${"x".repeat(7)}`;
    expect(token.length).toBe(20);
    const result = await claudeCodeTokenProvider.validate(token);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("truncated");
  });

  test("REJECTS one character below the floor", async () => {
    const token = `${PREFIX}${"x".repeat(46)}`;
    expect(token.length).toBe(59);
    expect((await claudeCodeTokenProvider.validate(token)).ok).toBe(false);
  });

  test("ACCEPTS exactly at the floor", async () => {
    const token = `${PREFIX}${"x".repeat(47)}`;
    expect(token.length).toBe(60);
    expect((await claudeCodeTokenProvider.validate(token)).ok).toBe(true);
  });

  test("ACCEPTS a real-length token, which is what the floor must never refuse", async () => {
    // 108 chars — the only length ever observed. The floor sits well below it
    // on purpose: refusing a real credential is the failure with a victim.
    expect(SUBSCRIPTION_TOKEN.length).toBe(108);
    expect((await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN)).ok).toBe(true);
  });
});

describe("an unrecognized value is REFUSED, not stored with a caveat (mt#5026)", () => {
  // `validate` is documented in ../types.ts as running BEFORE persisting, where
  // a failure means "do not store". So `ok: true` is the decision to write the
  // value into the credential store, not a grade on it. mt#5023 returned
  // `ok: true` for everything that was not an API key.
  test("REJECTS the gibberish the operator actually typed", async () => {
    const result = await claudeCodeTokenProvider.validate(GIBBERISH);
    expect(result.ok).toBe(false);
  });

  test("the message names the shape a subscription token has", async () => {
    const result = await claudeCodeTokenProvider.validate(GIBBERISH);
    expect(result.detail).toContain(SUBSCRIPTION_PREFIX);
  });

  test("the message names how to GET one, not just what it looks like", async () => {
    const result = await claudeCodeTokenProvider.validate(GIBBERISH);
    expect(result.detail).toContain(SETUP_TOKEN_COMMAND);
  });

  test("REJECTS an unrecognized sk-ant- segment — the family prefix is not a type", async () => {
    const result = await claudeCodeTokenProvider.validate(UNRECOGNIZED_SK_ANT_SHAPE);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(SUBSCRIPTION_PREFIX);
  });

  test("REJECTS a long random string, so length alone cannot buy acceptance", async () => {
    // The mt#5023 predicate accepted anything >= 20 chars that was not an API
    // key; this is that predicate's shape stated directly.
    const result = await claudeCodeTokenProvider.validate("a".repeat(200));
    expect(result.ok).toBe(false);
  });

  test("test() refuses it too — both stages, not just the pre-store one", async () => {
    expect((await claudeCodeTokenProvider.test(GIBBERISH)).ok).toBe(false);
  });
});

describe("shape checks", () => {
  test("rejects empty", async () => {
    expect((await claudeCodeTokenProvider.validate("")).ok).toBe(false);
  });

  test("rejects whitespace-only, which trims to empty", async () => {
    expect((await claudeCodeTokenProvider.validate("   ")).ok).toBe(false);
  });

  test("reports the length it saw for a truncated REAL token", async () => {
    // The length check runs only after the shape matches, so "too short" is
    // reserved for a token of the right kind that was cut off mid-paste —
    // telling someone who pasted the wrong secret entirely that it is "too
    // short" would send them looking for a longer wrong secret.
    const result = await claudeCodeTokenProvider.validate("sk-ant-oat01-abc");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("16");
    expect(result.detail).toContain("truncated");
  });

  test("a short NON-token gets the shape message, not the length one", async () => {
    const result = await claudeCodeTokenProvider.validate("abc123");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(SUBSCRIPTION_PREFIX);
    expect(result.detail).not.toContain("truncated");
  });

  test("accepts a plausible token", async () => {
    expect((await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN)).ok).toBe(true);
  });

  test("tolerates surrounding whitespace, which a paste routinely carries", async () => {
    expect((await claudeCodeTokenProvider.validate(`  ${SUBSCRIPTION_TOKEN}\n`)).ok).toBe(true);
  });
});

describe("the success detail does not claim a validation that did not happen", () => {
  // This is the property the whole design rests on: an unvalidatable credential
  // and a validated one must not look alike to a reader of the output.
  test("says it was saved AND that it is unverified", async () => {
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("saved");
    expect(result.detail).toContain("can't be tested");
  });

  test("stays in the sibling providers' register — short, and a result", async () => {
    // `authenticated as @octocat`, `3 projects visible`, `12 models accessible`.
    // What this replaced was 26 words and spent most of them arguing for its own
    // design. The bound is a proxy for register, not an aesthetic rule: a
    // message this short cannot fit a justification (mt#5027).
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.detail.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  test("carries no task id — the class invariant lives in user-facing-copy.test.ts", async () => {
    // Kept here as well because this provider is where the defect shipped, and
    // a per-provider assertion names the culprit directly when it regresses.
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.detail).not.toMatch(/mt#\d+/);
  });

  test("never reports an identity or a count, which would imply a live call", async () => {
    // The sibling anthropic provider returns "N models accessible" — a real
    // response. Anything shaped like that here would be a fabrication.
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.detail).not.toMatch(/\d+ model/);
    expect(result.detail).not.toContain("accessible");
  });

  test("never echoes the token itself into the detail string", async () => {
    // The detail is surfaced in the cockpit and the CLI, and both are
    // transcript-adjacent surfaces.
    const result = await claudeCodeTokenProvider.validate(SUBSCRIPTION_TOKEN);
    expect(result.detail).not.toContain(SUBSCRIPTION_TOKEN);
  });
});

describe("guidance", () => {
  test("names the acquisition command rather than only a URL", async () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain(SETUP_TOKEN_COMMAND);
  });

  test("states the billing distinction, which is the reason to pick this provider", () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("SUBSCRIPTION");
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("API credits");
  });

  test("warns that the stored value is unverified", () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain("not verified");
  });

  test("names the shape, so the operator knows what to look for before pasting", () => {
    expect(claudeCodeTokenProvider.scopeGuidance).toContain(SUBSCRIPTION_PREFIX);
  });
});
