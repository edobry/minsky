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
 * Return a model that sends exactly the caller's temperature — and nothing when
 * the caller specified none.
 *
 * AI SDK v4 substitutes `temperature: 0` for an omitted temperature inside its
 * own `prepareCallSettings`, which runs AFTER our call arguments are built, so
 * omitting the key at the `generateText` / `streamText` / `generateObject` call
 * site (mt#2733) cannot prevent it. `@ai-sdk/anthropic` then assigns that `0`
 * unconditionally, and `JSON.stringify` preserves a `0` where it would drop an
 * `undefined`, so it reaches the wire. Current Claude models reject the field's
 * mere presence, because adaptive thinking controls their sampling.
 *
 * `transformParams` is the only hook that runs after that defaulting and before
 * the provider builds its request; it covers both `doGenerate` and `doStream`.
 *
 * **`callerTemperature` is a required argument on purpose.** By the time the
 * middleware runs, an injected `0` and a caller's explicit `0` are
 * indistinguishable — `prepareCallSettings` has already collapsed them. So the
 * decision cannot be made inside the middleware; it must be made from the
 * caller's original intent, here. Taking that intent as a parameter is what
 * makes the wrapper impossible to misuse: there is no way to call this and
 * accidentally strip a value the caller asked for.
 *
 * Applied for every provider, not just Anthropic. The injected `0` is a value
 * no caller requested regardless of who receives it, and scoping the strip to a
 * list of temperature-rejecting models would mean hand-maintaining exactly the
 * kind of version-specific table that rots silently (mem#769, mt#3379, mt#3390,
 * mt#3457 are four instances of that defect class in this codebase already).
 *
 * Deliberately NOT `defaultSettingsMiddleware`: that helper's own code carries a
 * `// special case for temperature 0` branch which re-defaults a nullish-or-zero
 * temperature, reinstating what this removes.
 *
 * Goes stale when the pinned `ai` major moves: v5 drops the default outright
 * (the v4 source says so itself — `// TODO v5 remove default 0 for temperature`).
 * This then becomes a no-op and should be deleted rather than left as
 * unexplained indirection. Tracked by mt#3488.
 */
export function withCallerTemperatureOnly(
  model: LanguageModel,
  callerTemperature: number | undefined
): LanguageModel {
  if (callerTemperature !== undefined) {
    return model;
  }

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
