/**
 * AI Model Catalog
 *
 * Hardcoded fallback model definitions used when the model cache is unavailable.
 * Also provides the background-refresh helper for the cache service.
 */

import { AIModel, AIProviderConfig } from "./types";
import type { DefaultModelCacheService } from "./model-cache";
import { log } from "../../utils/logger";

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
      {
        id: "o1-preview",
        provider: "openai",
        name: "o1 Preview",
        description: "Advanced reasoning model with step-by-step thinking",
        capabilities: [{ name: "reasoning", supported: true, maxTokens: 128000 }],
        contextWindow: 128000,
        maxOutputTokens: 32768,
        costPer1kTokens: { input: 0.015, output: 0.06 },
      },
    ],
    anthropic: [
      {
        id: "claude-3-5-sonnet-20241022",
        provider: "anthropic",
        name: "Claude 3.5 Sonnet",
        description: "Most intelligent Claude model with enhanced capabilities",
        capabilities: caps,
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.003, output: 0.015 },
      },
      {
        id: "claude-3-5-haiku-20241022",
        provider: "anthropic",
        name: "Claude 3.5 Haiku",
        description: "Fast and cost-effective Claude model",
        capabilities: caps?.filter((c) => c.name !== "prompt-caching"),
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.001, output: 0.005 },
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
        id: "claude-3-5-sonnet-20241022",
        provider: "anthropic",
        name: "Claude 3.5 Sonnet",
        description: "Anthropic's most capable model",
        capabilities: caps,
        contextWindow: 200000,
        maxOutputTokens: 8192,
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
