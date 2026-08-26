/**
 * Config-backed credential resolution for harness scripts (mt#3547).
 *
 * `harness-auth.ts` reads environment variables only. That is correct for the
 * DEPLOYED reviewer, which gets its credentials as Railway env vars — but a
 * harness runs on a developer machine, where credentials normally live in
 * Minsky's own configuration. This module adds the config fallback for both
 * credentials the replay harnesses need.
 *
 * It is a separate module, not an extension of `harness-auth.ts`, because
 * reading the configuration pulls in tsyringe and therefore needs the
 * `reflect-metadata` polyfill imported below. Several harness scripts want only
 * a GitHub token and should not inherit that cost or that failure mode.
 */

import "reflect-metadata";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { getConfiguration, isConfigurationInitialized } from "@minsky/domain/configuration/index";

/**
 * Resolve the OpenAI API key for a harness script.
 *
 * Env first — that is how the DEPLOYED reviewer gets its key (`config.ts`'s
 * `requireEnv("OPENAI_API_KEY")` on Railway), so honoring it keeps a run
 * overridable and matches production. But a harness runs on a developer
 * machine, where the key normally lives in Minsky's own configuration
 * (`ai.providers.openai.apiKey`), not in the shell — so fall back to the
 * configuration system rather than declaring the key absent.
 *
 * Reading env alone is what made an earlier mt#3547 run conclude "no OpenAI
 * credential exists" and escalate to the operator for a decision, while
 * `minsky ai validate --provider openai` passed a live connection test the
 * whole time. A harness that ignores the project's config system does not get
 * to report the config as empty.
 *
 * Two traps this function exists to avoid, both hit while writing it:
 *
 * 1. `minsky config credentials list` does NOT enumerate openai (or morph) even
 *    when configured — see mt#3569. It is not a presence test. `minsky ai
 *    providers list` is.
 * 2. `getConfiguration()` THROWS until `setupConfiguration()` has run. A
 *    `catch` around it that returns undefined turns "not initialized" into
 *    "no key configured" — the same wrong answer, now with no error to see.
 *    So initialization is explicit and failures are reported, not swallowed.
 */
export async function resolveOpenAIKey(): Promise<string | undefined> {
  // Same whitespace-masking class as resolveProviderApiKeyWithConfig below (PR #3373 R1) —
  // trim before the presence check, still return the raw value.
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;

  if (!isConfigurationInitialized()) {
    await setupConfiguration();
  }
  return getConfiguration().ai?.providers?.openai?.apiKey || undefined;
}

export async function resolveOpenAIKeyOrSkip(): Promise<string> {
  const key = await resolveOpenAIKey();
  if (!key) {
    console.log(
      "SKIP: no OpenAI API key. Set OPENAI_API_KEY, or configure it in Minsky\n" +
        "(`minsky config credentials add openai`, stored at ai.providers.openai.apiKey).\n" +
        "Check what is actually configured with `minsky ai providers list` —\n" +
        "`minsky config credentials list` does not enumerate openai (mt#3569)."
    );
    process.exit(0);
  }
  return key;
}

/** Where the key came from, for the run header. Never returns the key itself. */
export async function getOpenAIKeySource(): Promise<"OPENAI_API_KEY" | "minsky-config" | "none"> {
  if (process.env.OPENAI_API_KEY) return "OPENAI_API_KEY";
  return (await resolveOpenAIKey()) ? "minsky-config" : "none";
}

/**
 * Config-backed key resolution for the non-OpenAI providers (mt#4620).
 *
 * `resolveOpenAIKey` above already does this for OpenAI (mt#3547); the same
 * env-first-then-config fallback is needed for google/anthropic wherever a
 * harness script gates a provider on an env var alone — reading env only is
 * what makes a session with no raw `GOOGLE_AI_API_KEY`/`ANTHROPIC_API_KEY` in
 * its shell conclude "no credential exists" while Minsky's own config (and
 * therefore `ai_complete`/`ai_validate`) has one. Same two traps
 * `resolveOpenAIKey` documents: `minsky config credentials list` is not a
 * presence test, and `getConfiguration()` throws until `setupConfiguration()`
 * has run — swallow neither.
 */
export async function resolveProviderApiKeyWithConfig(
  provider: "openai" | "google" | "anthropic",
  envVarName: string
): Promise<string | undefined> {
  // PR #3373 R1: a whitespace-only env var (e.g. an empty shell export left in place) is not a
  // real key — `if (fromEnv)` alone treats " " as truthy and returns it, silently masking a
  // valid config-stored credential behind an env var that was never meant to hold one. Trim
  // before the presence check; still return the RAW (untrimmed) value so a key that
  // legitimately starts/ends with whitespace round-trips unchanged.
  const fromEnv = process.env[envVarName];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;

  if (!isConfigurationInitialized()) {
    await setupConfiguration();
  }
  return getConfiguration().ai?.providers?.[provider]?.apiKey || undefined;
}

/**
 * GitHub token with the same config fallback (`github.token`).
 *
 * `harness-auth.ts`'s `resolveGitHubToken` checks `OCTOKIT_AUTH` then
 * `GITHUB_TOKEN` and stops. On a developer machine both are typically unset
 * while `github.token` is configured — so an env-only harness skips with
 * "no GitHub token" on a machine that has one.
 *
 * `OCTOKIT_AUTH` still wins when present: it exists to point harness traffic at
 * a separate App installation token for rate-limit isolation (mt#1502), which
 * is a deliberate override of whatever the config holds.
 */
export async function resolveGitHubTokenWithConfig(): Promise<string | undefined> {
  // Same whitespace-masking class as resolveProviderApiKeyWithConfig above (PR #3373 R1).
  const fromEnvRaw = process.env.OCTOKIT_AUTH || process.env.GITHUB_TOKEN;
  if (fromEnvRaw !== undefined && fromEnvRaw.trim().length > 0) return fromEnvRaw;

  if (!isConfigurationInitialized()) {
    await setupConfiguration();
  }
  return getConfiguration().github?.token || undefined;
}

export async function resolveGitHubTokenWithConfigOrSkip(): Promise<string> {
  const token = await resolveGitHubTokenWithConfig();
  if (!token) {
    console.log(
      "SKIP: no GitHub token. Set OCTOKIT_AUTH (App installation token, for\n" +
        "rate-limit isolation) or GITHUB_TOKEN, or configure `github.token` in Minsky."
    );
    process.exit(0);
  }
  return token;
}

/** Where the token came from, for the run header. Never returns the token. */
export async function getGitHubTokenSource(): Promise<
  "OCTOKIT_AUTH" | "GITHUB_TOKEN" | "minsky-config" | "none"
> {
  if (process.env.OCTOKIT_AUTH) return "OCTOKIT_AUTH";
  if (process.env.GITHUB_TOKEN) return "GITHUB_TOKEN";
  return (await resolveGitHubTokenWithConfig()) ? "minsky-config" : "none";
}
