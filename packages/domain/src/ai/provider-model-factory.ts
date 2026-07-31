/**
 * AI Provider Model Factory
 *
 * Creates and caches LanguageModel instances for each provider.
 */

import { LanguageModel, wrapLanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { AIProviderConfig, AIProviderError } from "./types";
import type { DefaultAIConfigurationService } from "./config-service";

/**
 * Default model IDs keyed by provider name.
 *
 * Goes stale when a provider retires a model: nothing here fails, and a call
 * that falls through to the retired id gets an error naming the model rather
 * than a configuration problem. `config doctor`'s Configured Model Validity
 * check (mt#3389) reports a configured default absent from the provider's
 * listing; verify against `minsky ai models available --provider <name>`.
 *
 * anthropic was `claude-3-5-sonnet-20241022` until 2026-07-31 — retired
 * 2025-10-28 and absent from the live listing, so every bare
 * `--provider anthropic` call 404'd (mt#2735).
 */
const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-5",
  google: "gemini-1.5-pro-latest",
  morph: "morph-v3-large",
};

export function getDefaultModel(provider: string): string {
  return DEFAULT_MODELS[provider] ?? "gpt-4o";
}

/**
 * Wrap a model so that no `temperature` reaches the provider at all.
 *
 * AI SDK v4 substitutes `temperature: 0` for an omitted temperature inside its
 * own `prepareCallSettings`, which runs AFTER our call arguments are built — so
 * omitting the key at the `generateText` / `streamText` / `generateObject` call
 * site (mt#2733) cannot prevent it. `@ai-sdk/anthropic` then assigns that `0`
 * to `baseArgs.temperature` unconditionally, and `JSON.stringify` preserves a
 * `0` where it would drop an `undefined` — so it reaches the wire. Current
 * Claude models reject the mere PRESENCE of the field ("`temperature` is
 * deprecated for this model"), because adaptive thinking controls its own
 * sampling.
 *
 * `transformParams` is the only hook that runs after that defaulting and before
 * the provider builds its request, and it covers both `doGenerate` and
 * `doStream`.
 *
 * Deliberately NOT `defaultSettingsMiddleware`: that helper's own
 * implementation carries a `// special case for temperature 0` branch which
 * re-defaults a nullish-or-zero temperature, reinstating exactly what this
 * removes.
 *
 * Goes stale when the pinned `ai` major moves — v5 drops the default outright
 * (the v4 source says so itself: `// TODO v5 remove default 0 for temperature`).
 * At that point this wrapper becomes a no-op and should be deleted rather than
 * left as unexplained indirection. Tracked by mt#3488.
 */
export function withTemperatureOmitted(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      middlewareVersion: "v1",
      transformParams: async ({ params }) => ({ ...params, temperature: undefined }),
    },
  });
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return providerModels.get(cacheKey)!;
  }

  const model = createLanguageModel(resolvedProvider, resolvedModel, providerConfig);
  providerModels.set(cacheKey, model);
  return model;
}
