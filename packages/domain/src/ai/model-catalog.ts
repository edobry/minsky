/**
 * AI Model Catalog
 *
 * Hardcoded fallback model definitions used when the model cache is unavailable.
 * Also provides the background-refresh helper for the cache service.
 *
 * These values stay hardcoded ON PURPOSE. This catalog is what
 * `completion-service.ts` falls back to when the model cache CANNOT be read, so
 * sourcing it from that cache would be circular — it would be empty in exactly
 * the situation this file exists to cover.
 *
 * What makes it go stale: providers retire models and ship new ones, and
 * nothing here fails when that happens — a retired id keeps being offered and a
 * new model's real limits are never represented. That is the same defect class
 * as mem#769 and mt#3379.
 *
 * What to check when it does: compare each entry against the provider's live
 * listing (`minsky ai models available --provider <name>`, which reads the
 * API-backed cache). An id the listing no longer returns is retired and should
 * be dropped; a limit that disagrees with the listing should be updated.
 *
 * Verification status of the current values (checked 2026-07-31, mt#3390):
 * - anthropic — VERIFIED against the live Anthropic listing, which returns
 *   `max_input_tokens` / `max_tokens` per model (measured in mt#3379).
 * - openai — UNVERIFIED. The local OpenAI cache is NOT independent evidence:
 *   its limits come from a hand-maintained table inside `openai-fetcher.ts`,
 *   not from the API, so agreement between the two proves nothing. Fixing that
 *   is mt#3457. Model IDS in the listing ARE API-sourced, which is how the
 *   retired `o1-preview` entry below was identified.
 * - google — UNVERIFIED. No local cache and no fetcher to compare against.
 */

import { AIModel, AIProviderConfig } from "./types";
import type { DefaultModelCacheService } from "./model-cache";
import { log } from "@minsky/shared/logger";

/**
 * Return the primary model definitions for a provider, using the
 * provider's supported capabilities where available.
 */
export function getPrimaryModels(
  provider: string,
  providerConfig: AIProviderConfig
): AIModel[] | null {
  const caps = providerConfig.supportedCapabilities;

  const catalog: Record<string, AIModel[]> = {
    openai: [
      {
        id: "gpt-4o",
        provider: "openai",
        name: "GPT-4o",
        description: "Most advanced GPT-4 model with improved reasoning",
        capabilities: caps,
        contextWindow: 128000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.005, output: 0.015 },
      },
      {
        id: "gpt-4o-mini",
        provider: "openai",
        name: "GPT-4o Mini",
        description: "Faster, more cost-efficient GPT-4o variant",
        capabilities: caps,
        contextWindow: 128000,
        maxOutputTokens: 16384,
        costPer1kTokens: { input: 0.00015, output: 0.0006 },
      },
      // `o1-preview` was dropped 2026-07-31: the OpenAI listing no longer
      // returns that id, so it is retired. No replacement reasoning model is
      // added here because this file has no verified source for one — see the
      // openai note in the file header.
    ],
    // costPer1kTokens is deliberately unset on these entries: the Anthropic
    // Models API returns no pricing field of any kind (measured in mt#3379), so
    // there is no source to refresh a price against. Carrying the retired
    // models' old prices forward onto current models would be inventing data.
    // Every consumer guards on the field being present.
    anthropic: [
      {
        id: "claude-opus-5",
        provider: "anthropic",
        name: "Claude Opus 5",
        description: "Most capable Claude model",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
      {
        id: "claude-sonnet-5",
        provider: "anthropic",
        name: "Claude Sonnet 5",
        description: "Balanced Claude model for general use",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
      {
        id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        name: "Claude Haiku 4.5",
        description: "Fast and cost-effective Claude model",
        capabilities: caps?.filter((c) => c.name !== "prompt-caching"),
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
    ],
    google: [
      {
        id: "gemini-1.5-pro-latest",
        provider: "google",
        name: "Gemini 1.5 Pro",
        description: "Google's most capable multimodal model",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.00125, output: 0.005 },
      },
      {
        id: "gemini-1.5-flash",
        provider: "google",
        name: "Gemini 1.5 Flash",
        description: "Fast and efficient Gemini model",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.000075, output: 0.0003 },
      },
    ],
  };

  return catalog[provider] ?? null;
}

/**
 * Minimal fallback models used when all other approaches fail.
 */
export function getFallbackModels(provider: string, providerConfig: AIProviderConfig): AIModel[] {
  const caps = providerConfig.supportedCapabilities;

  const fallback: Record<string, AIModel[]> = {
    openai: [
      {
        id: "gpt-4o",
        provider: "openai",
        name: "GPT-4o",
        description: "OpenAI's most capable model",
        capabilities: caps,
        contextWindow: 128000,
        maxOutputTokens: 4096,
      },
    ],
    anthropic: [
      {
        id: "claude-opus-5",
        provider: "anthropic",
        name: "Claude Opus 5",
        description: "Anthropic's most capable model",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
      },
    ],
    google: [
      {
        id: "gemini-1.5-pro-latest",
        provider: "google",
        name: "Gemini 1.5 Pro",
        description: "Google's most capable model",
        capabilities: caps,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      },
    ],
  };

  return fallback[provider] ?? [];
}

/**
 * Refresh the model cache for a provider in the background.
 * Errors are logged but not thrown — this is a best-effort operation.
 */
export async function refreshProviderModelsInBackground(
  provider: string,
  providerConfig: AIProviderConfig,
  modelCacheService: DefaultModelCacheService
): Promise<void> {
  try {
    if (!providerConfig.apiKey) {
      log.debug(`No API key for provider ${provider}, skipping refresh`);
      return;
    }

    await modelCacheService.refreshProvider(provider, {
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL,
      timeout: 15000,
    });

    log.debug(`Successfully refreshed models for provider ${provider} in background`);
  } catch (error) {
    log.debug(`Background model refresh failed for provider ${provider}`, { error });
    // Don't throw — this is a background operation
  }
}
