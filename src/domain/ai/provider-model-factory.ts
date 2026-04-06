/**
 * AI Provider Model Factory
 *
 * Creates and caches LanguageModel instances for each provider.
 */

import { LanguageModel } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { AIProviderConfig, AIProviderError } from "./types";
import type { DefaultAIConfigurationService } from "./config-service";

/** Default model IDs keyed by provider name */
const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-20241022",
  google: "gemini-1.5-pro-latest",
  morph: "morph-v3-large",
};

export function getDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] ?? "gpt-4o";
}

/**
 * Instantiate a LanguageModel for the given provider and model name.
 * Throws AIProviderError for unknown or unconfigured providers.
 */
export function createLanguageModel(
  resolvedProvider: string,
  resolvedModel: string,
  providerConfig: AIProviderConfig
): LanguageModel {
  switch (resolvedProvider) {
    case "openai": {
      const openaiProvider = createOpenAI({
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL,
      });
      return openaiProvider(resolvedModel);
    }

    case "anthropic": {
      const anthropicProvider = createAnthropic({
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL,
      });
      return anthropicProvider(resolvedModel);
    }

    case "google": {
      const googleProvider = createGoogleGenerativeAI({
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL,
      });
      return googleProvider(resolvedModel);
    }

    case "morph": {
      const morphProvider = createOpenAI({
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL || "https://api.morphllm.com/v1",
      });
      return morphProvider(resolvedModel);
    }

    default:
      throw new AIProviderError(
        `Unsupported provider: ${resolvedProvider}`,
        resolvedProvider,
        "UNSUPPORTED_PROVIDER"
      );
  }
}

/**
 * Resolve and return a cached-or-new LanguageModel.
 *
 * Handles provider/model resolution from defaults and caches the result.
 */
export async function resolveLanguageModel(
  configService: DefaultAIConfigurationService,
  providerModels: Map<string, LanguageModel>,
  provider?: string,
  modelName?: string
): Promise<LanguageModel> {
  const defaultProvider = await configService.getDefaultProvider();
  const resolvedProvider = provider || defaultProvider;
  const providerConfig = await configService.getProviderConfig(resolvedProvider);

  if (!providerConfig) {
    throw new AIProviderError(
      `Provider '${resolvedProvider}' is not configured`,
      resolvedProvider,
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const resolvedModel =
    modelName || providerConfig.defaultModel || getDefaultModel(resolvedProvider);
  const cacheKey = `${resolvedProvider}:${resolvedModel}`;

  if (providerModels.has(cacheKey)) {
    return providerModels.get(cacheKey)!;
  }

  const model = createLanguageModel(resolvedProvider, resolvedModel, providerConfig);
  providerModels.set(cacheKey, model);
  return model;
}
