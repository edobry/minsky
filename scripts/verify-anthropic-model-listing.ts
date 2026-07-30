#!/usr/bin/env bun
/**
 * Verification artifact (mt#3337): exercises the Anthropic model-listing path
 * against the LIVE Anthropic API.
 *
 * The unit tests (`anthropic-fetcher.test.ts`) stub `fetch`, so they prove the
 * fetcher asks for the right URL — they cannot prove the real endpoint answers.
 * That gap is exactly what shipped the bug: the old `validateConnection` was
 * self-consistent and passed review, and only a live call revealed that its
 * hardcoded `claude-3-haiku-20240307` had been retired and returned 404.
 *
 * Runs BOTH halves of the path that was broken:
 *   1. `validateConnection` — the pre-check that was failing.
 *   2. `fetchModels` — the call that was never reached.
 *
 * Env-gated: skips gracefully (exit 0) when no Anthropic API key resolves.
 *
 * Usage:
 *   bun scripts/verify-anthropic-model-listing.ts
 *
 * @see mt#3337
 */
import "reflect-metadata";
import { AnthropicModelFetcher } from "@minsky/domain/ai/model-cache/fetchers/anthropic-fetcher";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Resolve the key without printing it. Prefers the env var; falls back to the
 * user config file so the script works in a normal dev environment.
 */
async function resolveApiKey(): Promise<string | null> {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const { setupConfiguration } = await import("@minsky/domain/config-setup");
    const { getConfiguration } = await import("@minsky/domain/configuration");
    await setupConfiguration();
    const cfg = getConfiguration() as {
      ai?: { providers?: Record<string, { apiKey?: string }> };
    };
    return cfg?.ai?.providers?.anthropic?.apiKey ?? null;
  } catch (err) {
    console.log(`(config load failed: ${String(err)})`);
    return null;
  }
}

const apiKey = await resolveApiKey();
if (!apiKey) {
  console.log("SKIP: no Anthropic API key available (ANTHROPIC_API_KEY unset, none in config).");
  process.exit(0);
}
console.log(`API key resolved (len=${apiKey.length})`);

const fetcher = new AnthropicModelFetcher();

// 1. The pre-check that was returning false and blocking everything.
const connected = await fetcher.validateConnection({ apiKey });
console.log(`validateConnection: ${connected}`);
if (!connected) {
  fail(
    "validateConnection returned false against the live API. This is the mt#3337 failure mode — " +
      "the model registry will report 'Failed to connect to provider: anthropic' while completions work."
  );
}

// 2. The fetch that the broken pre-check prevented from ever running.
const models = await fetcher.fetchModels({ apiKey });
console.log(`fetchModels returned: ${models.length} models`);
for (const m of models) {
  console.log(`  - ${m.id}`);
}

if (models.length === 0) {
  fail("fetchModels returned 0 models — the listing is still empty.");
}

// Success criterion 3: a Haiku-tier and an Opus-tier entry must both be present.
const hasHaiku = models.some((m) => m.id.includes("haiku"));
const hasOpus = models.some((m) => m.id.includes("opus"));
console.log(`\nhaiku-tier present: ${hasHaiku}`);
console.log(`opus-tier present:  ${hasOpus}`);
if (!hasHaiku) fail("no Haiku-tier model in the listing (success criterion 3).");
if (!hasOpus) fail("no Opus-tier model in the listing (success criterion 3).");

// Regression guard: the retired id must not reappear as a hardcoded probe.
const source = await Bun.file(
  new URL("../packages/domain/src/ai/model-cache/fetchers/anthropic-fetcher.ts", import.meta.url)
    .pathname
).text();
const validateBody = source.slice(
  source.indexOf("async validateConnection"),
  source.indexOf("private getStaticModels")
);
if (validateBody.includes("claude-3-haiku-20240307")) {
  fail("validateConnection still references the retired claude-3-haiku-20240307 id.");
}

console.log("\nPASS: connection validates, listing returns models, both tiers present,");
console.log("      and validateConnection carries no hardcoded model id.");
