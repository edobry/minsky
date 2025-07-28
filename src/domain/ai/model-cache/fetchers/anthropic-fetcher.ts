/**
 * Anthropic Model Fetcher
 *
 * Provides static model definitions for Anthropic models since they don't have a public models API.
 * Validates API connectivity and returns predefined model specifications.
 */

import { ModelFetcher, CachedProviderModel, ModelFetchConfig, ModelFetchError } from "../types";
import { AICapability } from "../../types";
import { log } from "../../../../utils/logger";

/**
 * Anthropic model fetcher implementation
 */
export class AnthropicModelFetcher implements ModelFetcher {
  readonly provider = "anthropic";

  private readonly defaultBaseURL = "https://api.anthropic.com/v1";
  private readonly testEndpoint = "/messages";

  /**
   * Fetch models by testing availability (Anthropic doesn't have a public models API)
   * We validate each model individually to check current availability
   */
  async fetchModels(config: ModelFetchConfig): Promise<CachedProviderModel[]> {
    try {
      log.debug("Fetching Anthropic models with live availability testing");

      // Get static model definitions
      const staticModels = this.getStaticModels();

      // Test each model for availability
      const availableModels: CachedProviderModel[] = [];
      const concurrentTests = 3; // Limit concurrent API calls

      for (let i = 0; i < staticModels.length; i += concurrentTests) {
        const batch = staticModels.slice(i, i + concurrentTests);
        const batchResults = await Promise.allSettled(
          batch.map((model) => this.testModelAvailability(model, config))
        );

        batchResults.forEach((result, index) => {
          const model = batch[index];
          if (!model) return; // Skip if model is undefined

          const updatedModel: CachedProviderModel = {
            id: model.id,
            provider: model.provider,
            name: model.name,
            description: model.description,
            capabilities: model.capabilities,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            costPer1kTokens: model.costPer1kTokens,
            fetchedAt: new Date(),
            status: result.status === "fulfilled" && result.value ? "available" : "unknown",
            providerMetadata: {
              ...model.providerMetadata,
              ...(result.status === "rejected" && {
                availabilityError: result.reason?.message,
              }),
            },
          };

          availableModels.push(updatedModel);
        });
      }

      log.info(
        `Tested ${staticModels.length} Anthropic models, ${availableModels.filter((m) => m.status === "available").length} confirmed available`
      );
      return availableModels;
    } catch (error) {
      if (error instanceof ModelFetchError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ModelFetchError(
        `Failed to fetch Anthropic models: ${errorMessage}`,
        this.provider,
        "FETCH_FAILED",
        undefined,
        { error: errorMessage }
      );
    }
  }

  /**
   * Get capabilities for a specific Anthropic model
   */
  async getModelCapabilities(modelId: string): Promise<AICapability[]> {
    return this.getStaticCapabilities(modelId);
  }

  /**
   * Validate API connectivity by attempting a minimal request
   */
  async validateConnection(config: ModelFetchConfig): Promise<boolean> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}${this.testEndpoint}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(config.timeout || 30000, 10000)
      );

      try {
        // Make a minimal request to test connectivity
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1,
            messages: [
              {
                role: "user",
                content: "test",
              },
            ],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // We expect this to return 200 (success) or sometimes 400 (bad request due to minimal content)
        // Both indicate the API is accessible and the key is valid
        return response.status === 200 || response.status === 400;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.debug(`Anthropic connection validation failed`, { error });
      return false;
    }
  }

  /**
   * Get static model definitions for Anthropic
   */
  private getStaticModels(): CachedProviderModel[] {
    const fetchedAt = new Date();

    return [
      {
        id: "claude-3-5-sonnet-20241022",
        provider: this.provider,
        name: "Claude 3.5 Sonnet",
        description: "Most capable Claude model with improved reasoning and coding",
        capabilities: this.getStaticCapabilities("claude-3-5-sonnet-20241022"),
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.003, output: 0.015 },
        fetchedAt,
        status: "available",
        providerMetadata: {
          family: "claude-3-5",
          variant: "sonnet",
          release_date: "2024-10-22",
        },
      },
      {
        id: "claude-3-5-haiku-20241022",
        provider: this.provider,
        name: "Claude 3.5 Haiku",
        description: "Fast and cost-effective model for everyday tasks",
        capabilities: this.getStaticCapabilities("claude-3-5-haiku-20241022"),
        contextWindow: 200000,
        maxOutputTokens: 8192,
        costPer1kTokens: { input: 0.0008, output: 0.004 },
        fetchedAt,
        status: "available",
        providerMetadata: {
          family: "claude-3-5",
          variant: "haiku",
          release_date: "2024-10-22",
        },
      },
      {
        id: "claude-3-opus-20240229",
        provider: this.provider,
        name: "Claude 3 Opus",
        description: "Most powerful Claude 3 model for complex reasoning tasks",
        capabilities: this.getStaticCapabilities("claude-3-opus-20240229"),
        contextWindow: 200000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.015, output: 0.075 },
        fetchedAt,
        status: "available",
        providerMetadata: {
          family: "claude-3",
          variant: "opus",
          release_date: "2024-02-29",
        },
      },
      {
        id: "claude-3-sonnet-20240229",
        provider: this.provider,
        name: "Claude 3 Sonnet",
        description: "Balanced model for a wide range of tasks",
        capabilities: this.getStaticCapabilities("claude-3-sonnet-20240229"),
        contextWindow: 200000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.003, output: 0.015 },
        fetchedAt,
        status: "available",
        providerMetadata: {
          family: "claude-3",
          variant: "sonnet",
          release_date: "2024-02-29",
        },
      },
      {
        id: "claude-3-haiku-20240307",
        provider: this.provider,
        name: "Claude 3 Haiku",
        description: "Fast and cost-effective model for simple tasks",
        capabilities: this.getStaticCapabilities("claude-3-haiku-20240307"),
        contextWindow: 200000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.00025, output: 0.00125 },
        fetchedAt,
        status: "available",
        providerMetadata: {
          family: "claude-3",
          variant: "haiku",
          release_date: "2024-03-07",
        },
      },
      {
        id: "claude-2.1",
        provider: this.provider,
        name: "Claude 2.1",
        description: "Previous generation Claude model",
        capabilities: this.getStaticCapabilities("claude-2.1"),
        contextWindow: 200000,
        maxOutputTokens: 4096,
        costPer1kTokens: { input: 0.008, output: 0.024 },
        fetchedAt,
        status: "deprecated",
        providerMetadata: {
          family: "claude-2",
          variant: "standard",
          release_date: "2023-11-21",
        },
      },
    ];
  }

  /**
   * Get static capabilities for Anthropic models
   */
  private getStaticCapabilities(modelId: string): AICapability[] {
    // Claude 3.5 family
    if (modelId.startsWith("claude-3-5")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 200000 },
        { name: "tool-calling", supported: true },
        { name: "structured-output", supported: true },
        { name: "image-input", supported: true },
        { name: "prompt-caching", supported: true },
      ];
    }

    // Claude 3 family
    if (modelId.startsWith("claude-3")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 200000 },
        { name: "tool-calling", supported: true },
        { name: "structured-output", supported: true },
        { name: "image-input", supported: true },
        { name: "prompt-caching", supported: true },
      ];
    }

    // Claude 2 family
    if (modelId.startsWith("claude-2")) {
      return [
        { name: "reasoning", supported: true, maxTokens: 200000 },
        { name: "tool-calling", supported: false },
        { name: "structured-output", supported: false },
        { name: "image-input", supported: false },
        { name: "prompt-caching", supported: false },
      ];
    }

    // Legacy models
    return [
      { name: "reasoning", supported: true, maxTokens: 100000 },
      { name: "tool-calling", supported: false },
      { name: "structured-output", supported: false },
      { name: "image-input", supported: false },
      { name: "prompt-caching", supported: false },
    ];
  }

  /**
   * Test if a specific model is currently available by making a minimal API call
   */
  private async testModelAvailability(
    model: CachedProviderModel,
    config: ModelFetchConfig
  ): Promise<boolean> {
    try {
      const baseURL = config.baseURL || this.defaultBaseURL;
      const url = `${baseURL}${this.testEndpoint}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model.id,
            max_tokens: 1,
            messages: [
              {
                role: "user",
                content: "test",
              },
            ],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // 200 = success, 400 = bad request (but model exists)
        // 404 or other errors likely mean model doesn't exist
        return response.status === 200 || response.status === 400;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      log.debug(`Model availability test failed for ${model.id}`, { error });
      return false;
    }
  }
}
