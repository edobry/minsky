/**
 * Community model-limits catalog (mt#3457).
 *
 * OpenAI's `GET /v1/models` returns ONLY `id` / `object` / `created` / `owned_by` — no context
 * window, no output limit, no pricing, for any model. Measured 2026-08-09 over the union of every
 * key across all 132 entries in the live listing, so this is a property of the endpoint, not of
 * particular models. It is a known, long-standing gap: there is a standing OpenAI feature request
 * to expose model capabilities in `/v1/models`, and the same absence breaks OpenAI-COMPATIBLE
 * servers (clients treat vision models as text-only because nothing in the listing says otherwise).
 *
 * Anthropic's API DOES return `max_input_tokens` / `max_tokens`, which is what let mt#3379 source
 * Anthropic limits directly from the provider. That is the exception among providers, not the
 * norm — so the asymmetry between the two fetchers is inherent to the providers rather than an
 * artifact of our code.
 *
 * What this module does instead: read the limits from a maintained community catalog. This
 * replaces a hand-maintained table that had no staleness signal (the `mem#769` defect class) with
 * an upstream artifact that is updated continuously and can be checked for drift.
 *
 * ## Why LiteLLM's catalog
 *
 * Two independent catalogs were evaluated against the live listing (mt#3457 `## Why the API
 * carries no limits`):
 *
 *   - LiteLLM `model_prices_and_context_window.json` — 2,988 entries, covers 122 of our 132
 *     live OpenAI ids.
 *   - models.dev `api.json` — purpose-built, but covers only 45 of 132.
 *
 * They agree exactly wherever both carry data (verified on six shared models), which is
 * independent corroboration rather than a single source of truth taken on faith.
 *
 * LICENSE: `gh api repos/BerriAI/litellm` reports `NOASSERTION`, which normally blocks adoption.
 * The actual LICENSE file is a dual arrangement — everything OUTSIDE `enterprise/` is MIT, and
 * this JSON lives at the repository root. NOASSERTION is GitHub's detector failing on the
 * dual-license preamble, not a restrictive license. Re-check this if the file ever moves.
 *
 * ## Failure posture
 *
 * Every failure path returns `null` (catalog unavailable) rather than throwing or substituting
 * defaults. A caller that cannot get the catalog must omit the model, never invent a number —
 * a fabricated limit is worse than an absent model, because `contextWindow` is exactly the field
 * a caller consults to decide whether a payload fits (mt#3379's rationale, which this preserves).
 */

import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../../errors/index";

/** Raw shape of one entry in LiteLLM's catalog. Only the fields this module reads. */
interface CatalogEntry {
  litellm_provider?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

/** Limits for a single model, in the shape `AIModel` expects. */
export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kTokens?: { input: number; output: number };
}

/** Model id → limits, for one provider. */
export type ModelLimitsCatalog = ReadonlyMap<string, ModelLimits>;

export const LITELLM_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Default timeout. The catalog is ~1.6 MB and is fetched once per cache refresh, not per call,
 * so this is a background-refresh budget rather than a request-path one.
 */
export const CATALOG_FETCH_TIMEOUT_MS = 20_000;

/** LiteLLM states cost per SINGLE token; `AIModel.costPer1kTokens` wants per 1,000. */
const TOKENS_PER_COST_UNIT = 1000;

/**
 * Project one raw catalog entry onto `ModelLimits`.
 *
 * Returns `null` unless BOTH limits are present. A partial entry is treated as absent rather than
 * half-filled: a model with a context window but no output limit would still force the caller to
 * invent the missing half, which is the behavior this module exists to remove.
 *
 * Exported for testing — it is the whole projection decision, and testing it directly avoids
 * mocking a 1.6 MB payload to assert a field mapping.
 */
export function projectCatalogEntry(entry: CatalogEntry): ModelLimits | null {
  const contextWindow = entry.max_input_tokens;
  const maxOutputTokens = entry.max_output_tokens;

  if (typeof contextWindow !== "number" || typeof maxOutputTokens !== "number") {
    return null;
  }

  const limits: ModelLimits = { contextWindow, maxOutputTokens };

  // Pricing is optional and independent: a model may carry limits without costs. Only emit the
  // pair when BOTH sides are present, since a half-populated cost object reads as authoritative.
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input === "number" && typeof output === "number") {
    return {
      ...limits,
      costPer1kTokens: {
        input: input * TOKENS_PER_COST_UNIT,
        output: output * TOKENS_PER_COST_UNIT,
      },
    };
  }

  return limits;
}

/**
 * Build the provider-scoped catalog from an already-parsed payload.
 *
 * Exported separately from the network fetch so the parsing logic is testable without a fetch
 * seam, and so a future vendored-file path can reuse it unchanged.
 */
export function buildCatalogFromPayload(
  payload: unknown,
  provider: string
): ModelLimitsCatalog | null {
  if (typeof payload !== "object" || payload === null) {
    log.warn("Model-limits catalog payload was not an object; treating catalog as unavailable", {
      provider,
    });
    return null;
  }

  const catalog = new Map<string, ModelLimits>();

  for (const [modelId, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;

    const entry = raw as CatalogEntry;
    if (entry.litellm_provider !== provider) continue;

    const limits = projectCatalogEntry(entry);
    if (limits) {
      catalog.set(modelId, limits);
    }
  }

  if (catalog.size === 0) {
    // An empty catalog for a provider the upstream is known to cover means the schema moved
    // under us. Reporting it as unavailable (rather than as "no models have limits") keeps the
    // caller's degrade path honest and makes the condition visible.
    log.warn("Model-limits catalog contained no entries for provider; schema may have changed", {
      provider,
      url: LITELLM_CATALOG_URL,
    });
    return null;
  }

  return catalog;
}

/**
 * Fetch and parse the community catalog for one provider.
 *
 * `fetchImpl` is injected so callers and tests can supply their own transport; production passes
 * nothing and gets global `fetch`.
 *
 * Returns `null` on ANY failure — network, non-2xx, malformed JSON, unexpected schema. Never
 * throws, so a catalog outage degrades the model refresh instead of failing it.
 */
export async function fetchModelLimitsCatalog(
  provider: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; url?: string } = {}
): Promise<ModelLimitsCatalog | null> {
  const {
    fetchImpl = fetch,
    timeoutMs = CATALOG_FETCH_TIMEOUT_MS,
    url = LITELLM_CATALOG_URL,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Minsky" },
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn("Model-limits catalog fetch returned a non-OK status; catalog unavailable", {
        provider,
        url,
        status: response.status,
      });
      return null;
    }

    const payload: unknown = await response.json();
    return buildCatalogFromPayload(payload, provider);
  } catch (error) {
    log.warn("Model-limits catalog fetch failed; catalog unavailable", {
      provider,
      url,
      error: getLoggableErrorSummary(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
