#!/usr/bin/env bun
/**
 * Verification artifact (mt#3457): checks that cached OpenAI model metadata agrees with the
 * community limits catalog, and that nothing is being fabricated.
 *
 * Why this is needed even with unit tests: `openai-fetcher.test.ts` stubs both the listing and
 * the catalog, so it proves the mapping is applied to shapes we wrote down — it cannot prove
 * those shapes are what OpenAI and the catalog actually send. That gap is exactly what shipped
 * the bug this task fixes: the old hand-maintained overlay was self-consistent, passed review,
 * and reported an 8192-token window for `gpt-4.1` (actual 1,047,576) because 128 of 132 live
 * models fell through a `startsWith` branch.
 *
 * Deliberately rot-proof, following mt#3379's precedent: this asserts the fetcher AGREES WITH
 * the live catalog rather than hardcoding today's numbers. Pinning a version-specific value is
 * the defect class (mem#769) these tasks came from — an artifact asserting `1047576` would need
 * editing on OpenAI's next model release and would fail for the wrong reason until someone did.
 * Concrete values are PRINTED, not asserted.
 *
 * Env-gated: skips gracefully (exit 0) when no OpenAI API key resolves.
 *
 * Usage:
 *   bun scripts/verify-openai-model-metadata.ts
 *
 * @see mt#3457, mt#3379
 */
import "reflect-metadata";
import { OpenAIModelFetcher } from "@minsky/domain/ai/model-cache/fetchers/openai-fetcher";
import { fetchModelLimitsCatalog } from "@minsky/domain/ai/model-cache/model-limits-catalog";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Values the retired `startsWith` branches and generic fallback used to return. Their presence
 * across many models is the signature of the fabrication this task removed. Listed so the check
 * can look for the SHAPE of the old defect; a single model legitimately having one of these
 * numbers is fine and is not treated as a failure on its own.
 */
const RETIRED_FALLBACK_WINDOWS = [4096, 8192];

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/** Resolve the key without printing it. Env first, then the user config file. */
async function resolveApiKey(): Promise<string | null> {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    // A script is its own entry point: the domain config system is process-global and
    // uninitialized here, so `getConfiguration()` throws without this. Idempotent.
    const { setupConfiguration } = await import("@minsky/domain/config-setup");
    await setupConfiguration();

    const { getConfiguration } = await import("@minsky/domain/configuration/index");
    const key = (getConfiguration() as { ai?: { providers?: { openai?: { apiKey?: string } } } })
      ?.ai?.providers?.openai?.apiKey;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch (error) {
    // Surface WHY rather than swallowing into an indistinguishable "no key" — a config-init
    // failure and a genuinely absent key produce the same SKIP otherwise.
    console.error(
      `note: config lookup for the OpenAI key failed: ${getLoggableErrorSummary(error)}`
    );
    return null;
  }
}

async function main(): Promise<void> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.log("SKIP: no OpenAI API key resolved (set OPENAI_API_KEY or configure it).");
    process.exit(0);
  }

  // 1. The catalog must be reachable. If it is not, the fetcher degrades to returning nothing,
  //    which is safe but means this script cannot verify anything — report that distinctly
  //    rather than as a pass.
  const catalog = await fetchModelLimitsCatalog("openai");
  if (!catalog) {
    fail(
      "community limits catalog unavailable — the fetcher would degrade to caching no models. " +
        "This is the safe degrade, not a correctness failure, but it is not a verification either."
    );
  }
  console.log(`Catalog reachable: ${catalog.size} OpenAI entries carry published limits.`);

  // 2. Fetch through the real production path.
  const models = await new OpenAIModelFetcher().fetchModels({ apiKey });
  if (models.length === 0) {
    fail("fetcher returned zero models against a reachable catalog and a live listing");
  }
  console.log(`Fetcher returned ${models.length} cached models.`);

  // 3. AGREEMENT, not pinned values: every cached model's limits must match the catalog entry
  //    it was sourced from. A mismatch means something reintroduced a local override.
  const disagreements: string[] = [];
  for (const model of models) {
    const entry = catalog.get(model.id);
    if (!entry) {
      // A cached model with no catalog entry can only mean a value was invented somewhere.
      disagreements.push(`${model.id}: cached but absent from the catalog`);
      continue;
    }
    if (model.contextWindow !== entry.contextWindow) {
      disagreements.push(
        `${model.id}: contextWindow ${model.contextWindow} != catalog ${entry.contextWindow}`
      );
    }
    if (model.maxOutputTokens !== entry.maxOutputTokens) {
      disagreements.push(
        `${model.id}: maxOutputTokens ${model.maxOutputTokens} != catalog ${entry.maxOutputTokens}`
      );
    }
  }

  if (disagreements.length > 0) {
    console.error(disagreements.map((d) => `  - ${d}`).join("\n"));
    fail(`${disagreements.length} cached model(s) disagree with the catalog`);
  }
  console.log("All cached models agree with the catalog on both limits.");

  // 4. Shape check for the retired defect: the old fallbacks made MANY models share one window.
  //    Report the distribution rather than asserting a threshold — a legitimate cluster is
  //    possible, and this is diagnostic output for a human reading the run.
  const windowCounts = new Map<number, number>();
  for (const model of models) {
    windowCounts.set(model.contextWindow, (windowCounts.get(model.contextWindow) ?? 0) + 1);
  }
  for (const stale of RETIRED_FALLBACK_WINDOWS) {
    const count = windowCounts.get(stale) ?? 0;
    if (count > 0) {
      console.log(
        `Note: ${count} model(s) report a ${stale}-token window. That was a retired fallback ` +
          `value; verify these are genuine catalog values (they agreed above, so they are).`
      );
    }
  }

  // 5. Print a sample so a human can eyeball real numbers without the script asserting them.
  console.log("\nSample (id / context / max output):");
  for (const model of models.slice(0, 8)) {
    console.log(
      `  ${model.id.padEnd(34)} ${String(model.contextWindow).padStart(9)} ${String(
        model.maxOutputTokens
      ).padStart(7)}`
    );
  }

  console.log("\nPASS");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
