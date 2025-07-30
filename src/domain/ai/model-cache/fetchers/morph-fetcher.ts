/**
 * Morph Model Fetcher
 *
 * Fetches available models from Morph API and caches them with metadata.
 * Since Morph is OpenAI-compatible, this fetcher extends the OpenAI implementation
 * but uses Morph-specific endpoints and model capabilities.
 */

import type { TypedModelFetcher } from "../../provider-registry";
import type { CachedProviderModel, ModelFetchConfig } from "../types";
import { AICapability } from "../../types";
import { log } from "../../../../utils/logger";

/**
 * Morph-specific model capabilities mapping
 */
const MORPH_MODEL_CAPABILITIES: Record<string, AICapability[]> = {
  "morph-v3-large": [
    { name: "fast-apply", supported: true, maxTokens: 32000 },
    { name: "reasoning", supported: true, maxTokens: 32000 },
    { name: "structured-output", supported: true },
    { name: "tool-calling", supported: false }, // Morph focuses on fast-apply, not tool calling
  ],
  "morph-v3-small": [
    { name: "fast-apply", supported: true, maxTokens: 16000 },
    { name: "reasoning", supported: true, maxTokens: 16000 },
    { name: "structured-output", supported: true },
  ],
};

/**
 * Morph model fetcher implementation
 * Uses OpenAI-compatible API but with Morph-specific configuration
 */
export class MorphModelFetcher implements TypedModelFetcher<"morph"> {
  readonly provider = "morph" as const;

  private readonly defaultBaseURL = "https://api.morphllm.com/v1";
  private readonly modelsEndpoint = "/models";

  /**
   * Fetch models from Morph API
   * Uses OpenAI-compatible /v1/models endpoint
   */
  async fetchModels(config: ModelFetchConfig): Promise<CachedProviderModel[]> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}${this.modelsEndpoint}`;

      log.debug(`Fetching Morph models from: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout || 30000);

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

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Handle OpenAI-compatible response format
        if (!data.data || !Array.isArray(data.data)) {
          throw new Error("Invalid response format from Morph API");
        }

        const models = await Promise.all(
          data.data.map((model: any) => this.convertToCachedModel(model))
        );

        log.info(`Successfully fetched ${models.length} models from Morph`);
        return models;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.error("Failed to fetch Morph models", { error });
      throw error;
    }
  }

  /**
   * Get capabilities for a specific Morph model
   */
  async getModelCapabilities(modelId: string): Promise<AICapability[]> {
    // Return static capabilities based on known Morph models
    return this.getStaticCapabilities(modelId);
  }

  /**
   * Validate API connectivity with Morph
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
      log.debug(`Morph connection validation failed`, { error });
      return false;
    }
  }

  /**
   * Convert Morph API model to our cached model format
   */
  private async convertToCachedModel(apiModel: any): Promise<CachedProviderModel> {
    const capabilities = await this.getModelCapabilities(apiModel.id);

    return {
      id: apiModel.id,
      name: apiModel.id, // Morph uses ID as display name
      provider: this.provider,
      description: this.getModelDescription(apiModel.id),
      capabilities,
      contextWindow: this.getContextWindow(apiModel.id),
      maxOutputTokens: this.getMaxOutputTokens(apiModel.id),
      costPer1kTokens: this.getCostInfo(apiModel.id),
      fetchedAt: new Date(),
      providerMetadata: {
        owned_by: apiModel.owned_by || "morph",
        created: apiModel.created || Date.now(),
        object: apiModel.object || "model",
        isFastApply: true, // All Morph models are fast-apply capable
      },
      status: "available" as const,
    };
  }

  /**
   * Get static capabilities for known Morph models
   */
  private getStaticCapabilities(modelId: string): AICapability[] {
    const capabilities = MORPH_MODEL_CAPABILITIES[modelId];
    if (capabilities) {
      return capabilities;
    }

    // Default capabilities for unknown Morph models
    // Assume fast-apply support since that's Morph's specialty
    return [
      { name: "fast-apply", supported: true, maxTokens: 16000 },
      { name: "reasoning", supported: true, maxTokens: 16000 },
      { name: "structured-output", supported: true },
    ];
  }

  /**
   * Get description for Morph models
   */
  private getModelDescription(modelId: string): string {
    const descriptions: Record<string, string> = {
      "morph-v3-large": "Morph's flagship fast-apply model with 98% accuracy and 4500+ tokens/sec",
      "morph-v3-small": "Morph's efficient fast-apply model optimized for speed",
    };

    return descriptions[modelId] || `Morph fast-apply model: ${modelId}`;
  }

  /**
   * Get context window size for Morph models
   */
  private getContextWindow(modelId: string): number {
    const contextWindows: Record<string, number> = {
      "morph-v3-large": 32000,
      "morph-v3-small": 16000,
    };

    return contextWindows[modelId] || 16000; // Default context window
  }

  /**
   * Get max output tokens for Morph models
   */
  private getMaxOutputTokens(modelId: string): number {
    const maxOutputTokens: Record<string, number> = {
      "morph-v3-large": 8000,
      "morph-v3-small": 4000,
    };

    return maxOutputTokens[modelId] || 4000; // Default max output
  }

  /**
   * Get cost information for Morph models
   */
  private getCostInfo(modelId: string): { input: number; output: number } | undefined {
    // Morph pricing information (example values)
    const costs: Record<string, { input: number; output: number }> = {
      "morph-v3-large": { input: 0.0015, output: 0.002 }, // Example: $1.50/$2.00 per 1K tokens
      "morph-v3-small": { input: 0.0005, output: 0.001 }, // Example: $0.50/$1.00 per 1K tokens
    };

    return costs[modelId]; // Return undefined if no cost info available
  }
}
