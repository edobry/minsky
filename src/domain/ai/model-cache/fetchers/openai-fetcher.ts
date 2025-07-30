/**
 * OpenAI Model Fetcher
 *
 * Fetches available models from OpenAI API and caches them with metadata.
 * Uses the OpenAI REST API /v1/models endpoint.
 */

import { ModelFetcher, CachedProviderModel, ModelFetchConfig, ModelFetchError } from "../types";
import { AICapability } from "../../types";
import { log } from "../../../../utils/logger";

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

        const data: OpenAIModelsListResponse = await response.json();

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

        // Convert OpenAI models to our cached model format
        const cachedModels = await Promise.all(
          data.data.map((model) => this.convertToCachedModel(model))
        );

        // Filter out non-GPT models that we don't support
        const supportedModels = cachedModels.filter((model) => this.isSupportedModel(model.id));

        log.debug(`Filtered to ${supportedModels.length} supported models`);
        return supportedModels;
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
  private async convertToCachedModel(apiModel: OpenAIModelResponse): Promise<CachedProviderModel> {
    const capabilities = this.getStaticCapabilities(apiModel.id);
    const modelInfo = this.getModelInfo(apiModel.id);

    return {
      id: apiModel.id,
      provider: this.provider,
      name: modelInfo.name,
      description: modelInfo.description,
      capabilities,
      contextWindow: modelInfo.contextWindow,
      maxOutputTokens: modelInfo.maxOutputTokens,
      costPer1kTokens: modelInfo.costPer1kTokens,
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
   * Get detailed model information
   */
  private getModelInfo(modelId: string): {
    name: string;
    description: string;
    contextWindow: number;
    maxOutputTokens: number;
    costPer1kTokens?: { input: number; output: number };
  } {
    // Known model specifications (these should be updated as OpenAI releases new models)
    const modelSpecs: Record<string, any> = {
      "gpt-4o": {
        name: "GPT-4o",
        description: "Most advanced GPT-4 model with improved reasoning",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.005, output: 0.015 },
      },
      "gpt-4o-mini": {
        name: "GPT-4o Mini",
        description: "Faster, more cost-efficient GPT-4o variant",
        contextWindow: 128000,
        maxOutputTokens: 16384,
        costPer1kTokens: { input: 0.00015, output: 0.0006 },
      },
      "o1-preview": {
        name: "o1 Preview",
        description: "Advanced reasoning model with step-by-step thinking",
        contextWindow: 128000,
        maxOutputTokens: 32768,
        costPer1kTokens: { input: 0.015, output: 0.06 },
      },
      "o1-mini": {
        name: "o1 Mini",
        description: "Faster reasoning model optimized for coding and math",
        contextWindow: 128000,
        maxOutputTokens: 65536,
        costPer1kTokens: { input: 0.003, output: 0.012 },
      },
      "gpt-4-turbo": {
        name: "GPT-4 Turbo",
        description: "Latest GPT-4 model with improved instruction following",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.01, output: 0.03 },
      },
      "gpt-3.5-turbo": {
        name: "GPT-3.5 Turbo",
        description: "Fast and capable model for most conversational tasks",
        contextWindow: 16385,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.0005, output: 0.0015 },
      },
    };

    // Check for exact match first
    if (modelSpecs[modelId]) {
      return modelSpecs[modelId];
    }

    // Fallback to pattern matching for variants
    if (modelId.startsWith("gpt-4o")) {
      return {
        name: `GPT-4o (${modelId})`,
        description: "GPT-4o model variant",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.005, output: 0.015 },
      };
    }

    if (modelId.startsWith("gpt-4")) {
      return {
        name: `GPT-4 (${modelId})`,
        description: "GPT-4 model variant",
        contextWindow: 8192,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.03, output: 0.06 },
      };
    }

    if (modelId.startsWith("gpt-3.5")) {
      return {
        name: `GPT-3.5 (${modelId})`,
        description: "GPT-3.5 model variant",
        contextWindow: 4096,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.0015, output: 0.002 },
      };
    }

    // Generic fallback
    return {
      name: modelId,
      description: `OpenAI model: ${modelId}`,
      contextWindow: 4096,
      maxOutputTokens: 4096,
    };
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
}
