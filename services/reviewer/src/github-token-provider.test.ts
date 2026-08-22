/**
 * Tests for the reviewer service's background-scheduler token provider (mt#4435).
 *
 * The defect these guard against was a SILENT one: `createTokenProvider` fell
 * through to `FallbackTokenProvider("")` when the domain config's
 * `github.serviceAccount` was absent, so the schedulers issued unauthenticated
 * requests that looked like a working poll loop until GitHub's 60/hour per-IP
 * budget ran out. Nothing threw, and nothing logged an error until the budget
 * was gone — so the assertions here are about the credential check FAILING
 * loudly, which is the behavior that was missing.
 */

import { describe, expect, test } from "bun:test";
import {
  createReviewerTokenProvider,
  findMissingReviewerCredentials,
  MissingReviewerCredentialsError,
  REVIEWER_CREDENTIAL_ENV_VARS as ENV,
  type ReviewerGitHubCredentials,
} from "./github-token-provider";

/**
 * A structurally-valid credential set. The key is a syntactically-shaped PEM
 * placeholder — no call in these tests exchanges it for a token, so it never
 * has to be a real key.
 */
const VALID: ReviewerGitHubCredentials = {
  appId: 3470137,
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
  installationId: 125403046,
};

describe("findMissingReviewerCredentials", () => {
  test("returns nothing for a complete credential set", () => {
    expect(findMissingReviewerCredentials(VALID)).toEqual([]);
  });

  test("flags a NaN appId — the shape parseInt yields for a non-numeric env var", () => {
    // config.ts does `parseInt(requireEnv(<the app-id var>), 10)`, so a
    // present-but-malformed value arrives as NaN rather than as a missing key.
    const missing = findMissingReviewerCredentials({ ...VALID, appId: Number.NaN });
    expect(missing).toEqual([ENV.appId]);
  });

  test("flags a NaN installationId for the same reason", () => {
    const missing = findMissingReviewerCredentials({ ...VALID, installationId: Number.NaN });
    expect(missing).toEqual([ENV.installationId]);
  });

  test("flags a zero or negative appId", () => {
    expect(findMissingReviewerCredentials({ ...VALID, appId: 0 })).toEqual([ENV.appId]);
  });

  test("flags an empty private key", () => {
    expect(findMissingReviewerCredentials({ ...VALID, privateKey: "" })).toEqual([ENV.privateKey]);
  });

  test("flags a whitespace-only private key, which an env var can easily hold", () => {
    expect(findMissingReviewerCredentials({ ...VALID, privateKey: "   \n  " })).toEqual([
      ENV.privateKey,
    ]);
  });

  test("reports every missing credential at once, not just the first", () => {
    const missing = findMissingReviewerCredentials({
      appId: Number.NaN,
      privateKey: "",
      installationId: Number.NaN,
    });
    expect(missing).toEqual([ENV.appId, ENV.privateKey, ENV.installationId]);
  });
});

describe("createReviewerTokenProvider", () => {
  test("returns a service-account-backed provider for valid credentials", () => {
    const provider = createReviewerTokenProvider(VALID);

    // The discriminating assertion: FallbackTokenProvider — the class the old
    // code silently produced — returns false here. A provider that reports true
    // is authenticating as the App.
    expect(provider.isServiceAccountConfigured()).toBe(true);
  });

  test("throws rather than returning an unauthenticated provider", () => {
    // This is the whole point of the module. The pre-mt#4435 behavior was to
    // return a usable-looking provider holding an empty token; the test asserts
    // the opposite outcome, not merely a different message.
    expect(() => createReviewerTokenProvider({ ...VALID, privateKey: "" })).toThrow(
      MissingReviewerCredentialsError
    );
  });

  test("names the specific missing env var in the error", () => {
    expect(() => createReviewerTokenProvider({ ...VALID, appId: Number.NaN })).toThrow(
      /MINSKY_REVIEWER_APP_ID/
    );
  });

  test("explains the consequence, so an operator reading the log knows why it matters", () => {
    let message = "";
    try {
      createReviewerTokenProvider({ ...VALID, privateKey: "" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/unauthenticated/i);
    expect(message).toMatch(/60/);
  });
});
