#!/usr/bin/env bun
/**
 * Verification artifact (mt#3379): checks that the cached Anthropic model
 * metadata matches what the LIVE `GET /v1/models` endpoint actually returns.
 *
 * The unit tests (`anthropic-fetcher.test.ts`) stub `fetch`, so they prove the
 * mapping is applied to a response shape we wrote down — they cannot prove that
 * shape is the one Anthropic sends. That gap is what shipped the bug: the old
 * overlay was self-consistent and passed review while reporting 200000/8192 for
 * every current model.
 *
 * Deliberately rot-proof: this asserts the fetcher AGREES WITH the live
 * response rather than hardcoding today's numbers. Naming a version-specific
 * value is the defect mt#3337 and mt#3379 both came from (see mem#769) — an
 * artifact that hardcodes `1000000` would need editing on Anthropic's next
 * context-window change and would fail for the wrong reason until someone did.
 * The concrete values are printed, not asserted.
 *
 * Env-gated: skips gracefully (exit 0) when no Anthropic API key resolves.
 *
 * Usage:
 *   bun scripts/verify-anthropic-model-metadata.ts
 *
 * @see mt#3379
 */
import "reflect-metadata";
import { AnthropicModelFetcher } from "@minsky/domain/ai/model-cache/fetchers/anthropic-fetcher";

/** The pair every current model wrongly reported before mt#3379. */
const STALE_DEFAULT_CONTEXT_WINDOW = 200000;
const STALE_DEFAULT_MAX_OUTPUT = 8192;

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

// The raw listing, used as the source of truth the fetcher is checked against.
const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
  method: "GET",
  headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) {
  fail(`listing endpoint returned HTTP ${response.status} ${response.statusText}`);
}
const body = (await response.json()) as {
  data?: Array<{ id: string; max_input_tokens?: number; max_tokens?: number }>;
};
const apiModels = body.data ?? [];
console.log(`live listing returned ${apiModels.length} models`);

const apiById = new Map(apiModels.map((m) => [m.id, m]));

const models = await new AnthropicModelFetcher().fetchModels({ apiKey });
console.log(`fetchModels returned: ${models.length} models\n`);

if (models.length === 0) {
  fail("fetchModels returned 0 models — the listing is empty or every model was excluded.");
}

console.log("model".padEnd(30), "context".padEnd(10), "maxOutput".padEnd(10), "cost");
for (const m of models) {
  console.log(
    m.id.padEnd(30),
    String(m.contextWindow).padEnd(10),
    String(m.maxOutputTokens).padEnd(10),
    m.costPer1kTokens ? JSON.stringify(m.costPer1kTokens) : "(unset)"
  );
}
console.log();

// 1. Every cached model's limits equal the live response's, field for field.
for (const model of models) {
  const apiModel = apiById.get(model.id);
  if (!apiModel) {
    fail(`cached model ${model.id} is absent from the live listing`);
  }
  if (model.contextWindow !== apiModel.max_input_tokens) {
    fail(
      `${model.id}: contextWindow ${model.contextWindow} != API max_input_tokens ` +
        `${apiModel.max_input_tokens}`
    );
  }
  if (model.maxOutputTokens !== apiModel.max_tokens) {
    fail(
      `${model.id}: maxOutputTokens ${model.maxOutputTokens} != API max_tokens ${apiModel.max_tokens}`
    );
  }
}
console.log(`limits match the live response for all ${models.length} models`);

// 2. No model still reports the stale hardcoded pair. This is the mt#3379
//    symptom itself; it would be caught by check 1 only if the API happened to
//    disagree, so assert it directly.
const stale = models.filter(
  (m) =>
    m.contextWindow === STALE_DEFAULT_CONTEXT_WINDOW &&
    m.maxOutputTokens === STALE_DEFAULT_MAX_OUTPUT
);
if (stale.length > 0) {
  fail(
    `${stale.length} model(s) still report the retired default ` +
      `${STALE_DEFAULT_CONTEXT_WINDOW}/${STALE_DEFAULT_MAX_OUTPUT}: ${stale
        .map((m) => m.id)
        .join(", ")}`
  );
}
console.log(
  `no model reports the retired ${STALE_DEFAULT_CONTEXT_WINDOW}/${STALE_DEFAULT_MAX_OUTPUT} default`
);

// 3. Every model the API listed is present — nothing was silently dropped for
//    want of limits.
const dropped = apiModels.filter(
  (m) => m.id.toLowerCase().includes("claude") && !models.some((c) => c.id === m.id)
);
if (dropped.length > 0) {
  fail(
    `${dropped.length} listed Claude model(s) were dropped: ${dropped.map((m) => m.id).join(", ")}`
  );
}
console.log("every Claude model in the listing survived into the cache");

// 4. The reasoning capability carries the model's real context window, not a
//    constant.
for (const model of models) {
  const reasoning = model.capabilities.find((c) => c.name === "reasoning");
  if (reasoning?.maxTokens !== model.contextWindow) {
    fail(
      `${model.id}: reasoning.maxTokens ${String(reasoning?.maxTokens)} != contextWindow ` +
        `${model.contextWindow}`
    );
  }
}
console.log("reasoning capability reports each model's real context window");

// 5. The raw API capability tree is preserved rather than dropped in the
//    projection onto AICapability's closed union.
const withoutTree = models.filter((m) => m.providerMetadata?.api_capabilities === undefined);
if (withoutTree.length > 0) {
  fail(
    `${withoutTree.length} model(s) lost the API capability tree: ${withoutTree
      .map((m) => m.id)
      .join(", ")}`
  );
}
console.log("raw API capability tree preserved in providerMetadata");

console.log("\nPASS: cached limits agree with the live listing, the retired default is gone,");
console.log("      no model was dropped, and capability data is sourced and preserved.");
