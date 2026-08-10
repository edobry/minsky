/**
 * OpenAI Model Fetcher
 *
 * Fetches available models from OpenAI API and caches them with metadata.
 * Uses the OpenAI REST API /v1/models endpoint.
 */

import { ModelFetcher, CachedProviderModel, ModelFetchConfig, ModelFetchError } from "../types";
import { AICapability, TokenizerInfo } from "../../types";
import { fetchModelLimitsCatalog, type ModelLimitsCatalog } from "../model-limits-catalog";
import { log } from "@minsky/shared/logger";

/**
 * OpenAI API model response structure
 */
interface OpenAIModelResponse {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenAIModelsListResponse {
  object: "list";
  data: OpenAIModelResponse[];
}

/**
 * OpenAI model fetcher implementation
 */
export class OpenAIModelFetcher implements ModelFetcher {
  readonly provider = "openai";

  private readonly defaultBaseURL = "https://api.openai.com/v1";
  private readonly modelsEndpoint = "/models";

  /**
   * Catalog lookup, injected so the limits source is a seam rather than a module reach.
   * Production constructs with no argument and gets the real fetch; tests supply a stub and
   * never touch the network. Injecting this (instead of letting a test patch global `fetch`)
   * is what keeps the omission behavior observable from a returned value.
   */
  private readonly fetchLimitsCatalog: typeof fetchModelLimitsCatalog;

  constructor(deps: { fetchLimitsCatalog?: typeof fetchModelLimitsCatalog } = {}) {
    this.fetchLimitsCatalog = deps.fetchLimitsCatalog ?? fetchModelLimitsCatalog;
  }

  /**
   * Fetch models from OpenAI API
   */
  async fetchModels(config: ModelFetchConfig): Promise<CachedProviderModel[]> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}${this.modelsEndpoint}`;

      log.debug(`Fetching OpenAI models from: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout || 30000);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "Minsky/1.0.0",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          throw new ModelFetchError(
            `OpenAI API request failed: ${response.status} ${response.statusText}`,
            this.provider,
            "API_REQUEST_FAILED",
            response.status,
            { url, error: errorText }
          );
        }

        const data: OpenAIModelsListResponse = (await response.json()) as OpenAIModelsListResponse;

        if (!data.data || !Array.isArray(data.data)) {
          throw new ModelFetchError(
            "Invalid response format from OpenAI API",
            this.provider,
            "INVALID_RESPONSE_FORMAT",
            undefined,
            { response: data }
          );
        }

        log.info(`Fetched ${data.data.length} models from OpenAI API`);

        // Filter out non-GPT models that we don't support before doing any per-model work.
        const supported = data.data.filter((model) => this.isSupportedModel(model.id));

        // The listing carries no limits (mt#3457) — source them from the community catalog,
        // once per refresh rather than per model. A null catalog is a degrade, not a failure:
        // every model is then omitted rather than given an invented limit.
        const limitsCatalog = await this.fetchLimitsCatalog(this.provider, {
          timeoutMs: config.timeout,
        });

        if (!limitsCatalog) {
          log.warn(
            "OpenAI model refresh: limits catalog unavailable, so no model can be cached with " +
              "trustworthy limits. Returning an empty set rather than fabricating values.",
            { provider: this.provider, listed: supported.length }
          );
          return [];
        }

        const converted = supported.map((model) => this.convertToCachedModel(model, limitsCatalog));
        const cachedModels = converted.filter(
          (model): model is CachedProviderModel => model !== null
        );

        const omitted = supported.length - cachedModels.length;
        if (omitted > 0) {
          // Visible by construction: an absence shows up in the count, where a plausible-looking
          // default would not (mt#3379's rationale).
          log.info(
            `OpenAI models omitted from cache for want of published limits: ${omitted} of ${supported.length}`,
            { provider: this.provider }
          );
        }

        log.debug(`Filtered to ${cachedModels.length} supported models`);
        return cachedModels;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error instanceof ModelFetchError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("abort")) {
        throw new ModelFetchError(
          "Request timeout while fetching OpenAI models",
          this.provider,
          "REQUEST_TIMEOUT",
          undefined,
          { timeout: config.timeout || 30000 }
        );
      }

      throw new ModelFetchError(
        `Failed to fetch OpenAI models: ${errorMessage}`,
        this.provider,
        "FETCH_FAILED",
        undefined,
        { error: errorMessage }
      );
    }
  }

  /**
   * Get capabilities for a specific OpenAI model
   */
  async getModelCapabilities(modelId: string): Promise<AICapability[]> {
    // Static capabilities based on known model families
    // This could be enhanced to use the API once OpenAI provides capability metadata
    return this.getStaticCapabilities(modelId);
  }

  /**
   * Validate API connectivity
   */
  async validateConnection(config: ModelFetchConfig): Promise<boolean> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}${this.modelsEndpoint}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(config.timeout || 30000, 10000)
      );

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.debug(`OpenAI connection validation failed`, { error });
      return false;
    }
  }

  /**
   * Convert OpenAI API model to our cached model format
   */
  private convertToCachedModel(
    apiModel: OpenAIModelResponse,
    limitsCatalog: ModelLimitsCatalog
  ): CachedProviderModel | null {
    const limits = limitsCatalog.get(apiModel.id);

    if (!limits) {
      // Omit rather than invent. `contextWindow` is exactly the field a caller consults to decide
      // whether a payload fits or which model to route to, so a fabricated value is worse than an
      // absent model — and the absence is visible in the omitted-count logged by fetchModels,
      // where a plausible-looking default is not. This is mt#3379's rule, applied to the provider
      // that publishes no limits at all.
      log.debug("OpenAI model omitted: no published limits in the community catalog", {
        modelId: apiModel.id,
      });
      return null;
    }

    return {
      id: apiModel.id,
      provider: this.provider,
      name: apiModel.id,
      description: `OpenAI's ${apiModel.id}`,
      capabilities: this.getStaticCapabilities(apiModel.id),
      contextWindow: limits.contextWindow,
      maxOutputTokens: limits.maxOutputTokens,
      costPer1kTokens: limits.costPer1kTokens,
      tokenizer: this.getTokenizerInfo(apiModel.id),
      fetchedAt: new Date(),
      status: this.getModelStatus(apiModel),
      providerMetadata: {
        object: apiModel.object,
        created: apiModel.created,
        owned_by: apiModel.owned_by,
      },
    };
  }

  /**
   * Check if model is supported by Minsky
   */
  private isSupportedModel(modelId: string): boolean {
    // Support GPT models, ChatGPT models, and specific other models
    const supportedPatterns = [
      /^gpt-4/,
      /^gpt-3\.5/,
      /^chatgpt/,
      /^o1-/,
      /^text-/,
      /^davinci/,
      /^curie/,
      /^babbage/,
      /^ada/,
    ];

    return supportedPatterns.some((pattern) => pattern.test(modelId));
  }

  /**
   * Get static capabilities for known model families
   */
  private getStaticCapabilities(modelId: string): AICapability[] {
    // GPT-4 family
    if (modelId.startsWith("gpt-4")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 128000 },
        { name: "tool-calling", supported: true },
        { name: "structured-output", supported: true },
        { name: "image-input", supported: modelId.includes("vision") },
      ];
    }

    // O1 family (reasoning models)
    if (modelId.startsWith("o1-")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 128000 },
        { name: "tool-calling", supported: false }, // O1 models don't support tools yet
        { name: "structured-output", supported: false },
        { name: "image-input", supported: false },
      ];
    }

    // GPT-3.5 family
    if (modelId.startsWith("gpt-3.5") || modelId.startsWith("chatgpt")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 16385 },
        { name: "tool-calling", supported: true },
        { name: "structured-output", supported: true },
        { name: "image-input", supported: false },
      ];
    }

    // Legacy models
    return [
      { name: "reasoning", supported: true, maxTokens: 4097 },
      { name: "tool-calling", supported: false },
      { name: "structured-output", supported: false },
      { name: "image-input", supported: false },
    ];
  }

  /**
   * Determine model status from API response
   */
  private getModelStatus(
    apiModel: OpenAIModelResponse
  ): "available" | "deprecated" | "disabled" | "unknown" {
    // Check for deprecated models
    const deprecatedModels = [
      "text-davinci-003",
      "text-davinci-002",
      "text-curie-001",
      "text-babbage-001",
      "text-ada-001",
      "davinci",
      "curie",
      "babbage",
      "ada",
    ];

    if (deprecatedModels.includes(apiModel.id)) {
      return "deprecated";
    }

    // All models returned by the API are generally available
    return "available";
  }

  /**
   * Get tokenizer information for OpenAI models
   */
  private getTokenizerInfo(modelId: string): TokenizerInfo {
    // GPT-4o and O1 models use o200k_base encoding
    if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1-")) {
      return {
        encoding: "o200k_base",
        library: "gpt-tokenizer",
        source: "fallback", // Could be "api" if we fetch from OpenAI API in the future
      };
    }

    // GPT-4 and GPT-3.5 models use cl100k_base encoding
    if (
      modelId.startsWith("gpt-4") ||
      modelId.startsWith("gpt-3.5") ||
      modelId.startsWith("chatgpt")
    ) {
      return {
        encoding: "cl100k_base",
        library: "gpt-tokenizer",
        source: "fallback",
      };
    }

    // Legacy models use p50k_base encoding
    if (
      modelId.startsWith("text-") ||
      modelId.startsWith("davinci") ||
      modelId.startsWith("curie") ||
      modelId.startsWith("babbage") ||
      modelId.startsWith("ada")
    ) {
      return {
        encoding: "p50k_base",
        library: "tiktoken",
        source: "fallback",
      };
    }

    // Default fallback for unknown OpenAI models
    return {
      encoding: "cl100k_base",
      library: "gpt-tokenizer",
      source: "fallback",
    };
  }
}
