/**
 * AI Completion Service
 *
 * Core service for multi-provider AI completions using Vercel AI SDK.
 * Supports OpenAI, Anthropic, Google, and other providers with unified interface.
 */

import { generateText, streamText, generateObject, LanguageModel } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

import {
  AICompletionService,
  AICompletionRequest,
  AICompletionResponse,
  AIModel,
  AIProviderConfig,
  AICompletionError,
  AIProviderError,
  ValidationResult,
  AIUsage,
} from "./types";
import { DefaultAIConfigurationService } from "./config-service";
import { DefaultModelCacheService, OpenAIModelFetcher, AnthropicModelFetcher } from "./model-cache";
import { ConfigurationService } from "../configuration/types";
import { log } from "../../utils/logger";

/**
 * Default AI completion service implementation
 */
export class DefaultAICompletionService implements AICompletionService {
  private configService: DefaultAIConfigurationService;
  private providerModels: Map<string, LanguageModel> = new Map();
  private modelCacheService: DefaultModelCacheService;

  constructor(configurationService: any) {
    this.configService = new DefaultAIConfigurationService(configurationService);

    // Initialize model cache service with fetchers
    this.modelCacheService = new DefaultModelCacheService();
    this.modelCacheService.registerFetcher(new OpenAIModelFetcher());
    this.modelCacheService.registerFetcher(new AnthropicModelFetcher());
  }

  /**
   * Generate a complete response from AI provider
   */
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    try {
      const model = await this.getLanguageModel(request.provider, request.model);
      const startTime = Date.now();

      log.debug("Starting AI completion", {
        provider: request.provider,
        model: request.model,
        hasTools: !!request.tools?.length,
        stream: request.stream,
      });

      // Prepare tools for Vercel AI SDK format
      const tools = request.tools
        ? Object.fromEntries(
            request.tools.map((tool) => [
              tool.name,
              {
                description: tool.description,
                parameters: tool.parameters,
                execute: tool.execute,
              },
            ])
          )
        : undefined;

      // Use generateText for non-streaming completions
      const result = await generateText({
        model,
        prompt: request.prompt,
        system: request.systemPrompt,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        tools,
        maxSteps: request.maxSteps,
      });

      const duration = Date.now() - startTime;
      log.debug("AI completion completed", {
        provider: request.provider,
        model: request.model,
        duration,
        usage: result.usage,
      });

      // Transform Vercel AI SDK response to our format
      return {
        content: result.text,
        model: request.model || "unknown",
        provider: request.provider || "unknown",
        usage: this.transformUsage(result.usage),
        toolCalls: result.toolCalls?.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.args,
          result: call.result,
        })),
        steps: result.steps?.map((step) => ({
          type: step.toolCalls ? "tool-call" : "text",
          content: step.text,
          toolCalls: step.toolCalls?.map((call) => ({
            id: call.toolCallId,
            name: call.toolName,
            arguments: call.args,
            result: call.result,
          })),
          usage: this.transformUsage(step.usage),
        })),
        finishReason: this.mapFinishReason(result.finishReason),
        metadata: {
          duration,
          modelId: result.experimental_providerMetadata?.modelId,
        },
      };
    } catch (error) {
      // Log at debug level - the error will be re-thrown and handled with user-friendly messages
      log.systemDebug(
        `AI completion failed for provider ${request.provider}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw this.transformError(error, request.provider, request.model);
    }
  }

  /**
   * Stream AI completion responses
   */
  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionResponse> {
    try {
      const model = await this.getLanguageModel(request.provider, request.model);

      log.debug("Starting AI streaming completion", {
        provider: request.provider,
        model: request.model,
        hasTools: !!request.tools?.length,
      });

      // Prepare tools for Vercel AI SDK format
      const tools = request.tools
        ? Object.fromEntries(
            request.tools.map((tool) => [
              tool.name,
              {
                description: tool.description,
                parameters: tool.parameters,
                execute: tool.execute,
              },
            ])
          )
        : undefined;

      const stream = streamText({
        model,
        prompt: request.prompt,
        system: request.systemPrompt,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        tools,
        maxSteps: request.maxSteps,
      });

      for await (const delta of stream.textStream) {
        yield {
          content: delta,
          model: request.model || "unknown",
          provider: request.provider || "unknown",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, // Updated in final chunk
          finishReason: "stop",
          metadata: { streaming: true },
        };
      }

      // Yield final result with complete usage information
      const finalResult = await stream.text;
      const usage = await stream.usage;

      yield {
        content: finalResult,
        model: request.model || "unknown",
        provider: request.provider || "unknown",
        usage: this.transformUsage(usage),
        toolCalls: (await stream.toolCalls)?.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.args,
          result: call.result,
        })),
        finishReason: this.mapFinishReason((await stream.finishReason) || "stop"),
        metadata: { streaming: false, final: true },
      };
    } catch (error) {
      log.error("AI streaming completion failed", { error, request });
      throw this.transformError(error, request.provider, request.model);
    }
  }

  /**
   * Generate structured object using AI provider
   */
  async generateObject(request: any): Promise<any> {
    try {
      const model = await this.getLanguageModel(request.provider, request.model);

      log.debug("Starting AI object generation", {
        provider: request.provider,
        model: request.model,
        hasSchema: !!request.schema,
      });

      const result = await generateObject({
        model,
        messages: request.messages,
        schema: request.schema,
        temperature: request.temperature || 0.3,
      });

      return result.object;
    } catch (error) {
      log.debug("AI object generation failed", {
        error: error instanceof Error ? error.message : error,
        provider: request.provider,
        model: request.model,
      });
      throw this.transformError(error, request.provider, request.model);
    }
  }

  /**
   * Get available models for a provider
   */
  async getAvailableModels(provider?: string): Promise<AIModel[]> {
    try {
      if (provider) {
        return this.getProviderModels(provider);
      }

      // Get all models from all configured providers
      const allModels: AIModel[] = [];
      const defaultProvider = await this.configService.getDefaultProvider();
      const providerConfig = await this.configService.getProviderConfig(defaultProvider);

      if (providerConfig) {
        allModels.push(...(await this.getProviderModels(defaultProvider)));
      }

      return allModels;
    } catch (error) {
      // Log at debug level - this is expected when providers aren't configured
      log.systemDebug(
        `Failed to get available models for provider ${provider}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * Validate configuration and provider connectivity
   */
  async validateConfiguration(): Promise<ValidationResult> {
    const errors: any[] = [];
    const warnings: any[] = [];

    try {
      const defaultProvider = await this.configService.getDefaultProvider();
      const providerConfig = await this.configService.getProviderConfig(defaultProvider);

      if (!providerConfig) {
        errors.push({
          field: "defaultProvider",
          message: `Default provider '${defaultProvider}' is not configured`,
          code: "PROVIDER_NOT_CONFIGURED",
        });
      } else {
        // Test API key validation
        const isValid = await this.configService.validateProviderKey(
          defaultProvider,
          providerConfig.apiKey || ""
        );

        if (!isValid) {
          errors.push({
            field: `providers.${defaultProvider}.apiKey`,
            message: `Invalid API key format for provider '${defaultProvider}'`,
            code: "INVALID_API_KEY_FORMAT",
          });
        }

        // Test model availability
        try {
          const model = await this.getLanguageModel(defaultProvider);
          if (!model) {
            warnings.push({
              field: `providers.${defaultProvider}.model`,
              message: `Could not initialize model for provider '${defaultProvider}'`,
              code: "MODEL_INITIALIZATION_WARNING",
            });
          }
        } catch (error) {
          warnings.push({
            field: `providers.${defaultProvider}.model`,
            message: `Model initialization warning: ${error instanceof Error ? error.message : String(error)}`,
            code: "MODEL_INITIALIZATION_WARNING",
          });
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    } catch (error) {
      log.error("Configuration validation failed", { error });
      return {
        valid: false,
        errors: [
          {
            field: "configuration",
            message: `Configuration validation failed: ${error instanceof Error ? error.message : String(error)}`,
            code: "VALIDATION_ERROR",
          },
        ],
        warnings,
      };
    }
  }

  /**
   * Get language model instance for provider and model
   */
  private async getLanguageModel(provider?: string, modelName?: string): Promise<LanguageModel> {
    const defaultProvider = await this.configService.getDefaultProvider();
    const resolvedProvider = provider || defaultProvider;
    const providerConfig = await this.configService.getProviderConfig(resolvedProvider);

    if (!providerConfig) {
      throw new AIProviderError(
        `Provider '${resolvedProvider}' is not configured`,
        resolvedProvider,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const resolvedModel =
      modelName || providerConfig.defaultModel || this.getDefaultModel(resolvedProvider);
    const cacheKey = `${resolvedProvider}:${resolvedModel}`;

    // Return cached model if available
    if (this.providerModels.has(cacheKey)) {
      return this.providerModels.get(cacheKey)!;
    }

    // Create new model instance
    let model: LanguageModel;

    switch (resolvedProvider) {
      case "openai":
        model = openai(resolvedModel, {
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseURL,
        });
        break;

      case "anthropic":
        model = anthropic(resolvedModel, {
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseURL,
        });
        break;

      case "google":
        model = google(resolvedModel, {
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseURL,
        });
        break;

      case "morph": {
        // Morph is OpenAI-compatible, so use createOpenAI to create a custom provider
        const morphProvider = createOpenAI({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.baseURL || "https://api.morphllm.com/v1",
        });
        model = (morphProvider as any)(resolvedModel); // Use the actual model name (e.g., morph-v3-large)
        break;
      }

      default:
        throw new AIProviderError(
          `Unsupported provider: ${resolvedProvider}`,
          resolvedProvider,
          "UNSUPPORTED_PROVIDER"
        );
    }

    // Cache the model
    this.providerModels.set(cacheKey, model);
    return model;
  }

  /**
   * Get default model for a provider
   */
  private getDefaultModel(provider: string): string {
    const defaultModels: Record<string, string> = {
      openai: "gpt-4o",
      anthropic: "claude-3-5-sonnet-20241022",
      google: "gemini-1.5-pro-latest",
      morph: "morph-v3-large",
    };

    return defaultModels[provider] || "gpt-4o";
  }

  /**
   * Get available models for a specific provider using cache service
   */
  private async getProviderModels(provider: string): Promise<AIModel[]> {
    const providerConfig = await this.configService.getProviderConfig(provider);

    if (!providerConfig) {
      return [];
    }

    try {
      // Try to get cached models first
      const cachedModels = await this.modelCacheService.getCachedModels(provider);

      if (cachedModels.length > 0) {
        // Check if cache is stale and refresh in background if needed
        if (await this.modelCacheService.isCacheStale(provider)) {
          // Refresh in background (don't await)
          this.refreshProviderModelsInBackground(provider, providerConfig);
        }

        // Convert cached models to AIModel format
        return cachedModels.map((cachedModel) => ({
          id: cachedModel.id,
          provider: cachedModel.provider,
          name: cachedModel.name,
          description: cachedModel.description,
          capabilities: cachedModel.capabilities,
          contextWindow: cachedModel.contextWindow,
          maxOutputTokens: cachedModel.maxOutputTokens,
          costPer1kTokens: cachedModel.costPer1kTokens,
        }));
      }

      // If no cached models, try to fetch fresh ones (with timeout)
      if (providerConfig.apiKey) {
        log.debug(`No cached models for ${provider}, attempting fresh fetch`);
        await this.refreshProviderModelsInBackground(provider, providerConfig);

        // Try to get cached models again after refresh
        const refreshedModels = await this.modelCacheService.getCachedModels(provider);
        if (refreshedModels.length > 0) {
          return refreshedModels.map((cachedModel) => ({
            id: cachedModel.id,
            provider: cachedModel.provider,
            name: cachedModel.name,
            description: cachedModel.description,
            capabilities: cachedModel.capabilities,
            contextWindow: cachedModel.contextWindow,
            maxOutputTokens: cachedModel.maxOutputTokens,
            costPer1kTokens: cachedModel.costPer1kTokens,
          }));
        }
      }

      // Fallback to hardcoded models if cache fails
      const modelDefinitions: Record<string, AIModel[]> = {
        openai: [
          {
            id: "gpt-4o",
            provider: "openai",
            name: "GPT-4o",
            description: "Most advanced GPT-4 model with improved reasoning",
            capabilities: providerConfig.supportedCapabilities,
            contextWindow: 128000,
            maxOutputTokens: 4096,
            costPer1kTokens: { input: 0.005, output: 0.015 },
          },
          {
            id: "gpt-4o-mini",
            provider: "openai",
            name: "GPT-4o Mini",
            description: "Faster, more cost-efficient GPT-4o variant",
            capabilities: providerConfig.supportedCapabilities,
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
            capabilities: providerConfig.supportedCapabilities,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            costPer1kTokens: { input: 0.003, output: 0.015 },
          },
          {
            id: "claude-3-5-haiku-20241022",
            provider: "anthropic",
            name: "Claude 3.5 Haiku",
            description: "Fast and cost-effective Claude model",
            capabilities: providerConfig.supportedCapabilities.filter(
              (c) => c.name !== "prompt-caching"
            ),
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
            capabilities: providerConfig.supportedCapabilities,
            contextWindow: 1000000,
            maxOutputTokens: 8192,
            costPer1kTokens: { input: 0.00125, output: 0.005 },
          },
          {
            id: "gemini-1.5-flash",
            provider: "google",
            name: "Gemini 1.5 Flash",
            description: "Fast and efficient Gemini model",
            capabilities: providerConfig.supportedCapabilities,
            contextWindow: 1000000,
            maxOutputTokens: 8192,
            costPer1kTokens: { input: 0.000075, output: 0.0003 },
          },
        ],
      };

      return modelDefinitions[provider] || [];
    } catch (error) {
      log.warn(`Failed to get models for provider ${provider}, falling back to minimal set`, {
        error,
      });

      // Return minimal fallback models
      const fallbackModels: Record<string, AIModel[]> = {
        openai: [
          {
            id: "gpt-4o",
            provider: "openai",
            name: "GPT-4o",
            description: "OpenAI's most capable model",
            capabilities: providerConfig.supportedCapabilities,
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
            capabilities: providerConfig.supportedCapabilities,
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
            capabilities: providerConfig.supportedCapabilities,
            contextWindow: 1000000,
            maxOutputTokens: 8192,
          },
        ],
      };

      return fallbackModels[provider] || [];
    }
  }

  /**
   * Refresh models for a provider in the background
   */
  private async refreshProviderModelsInBackground(
    provider: string,
    providerConfig: AIProviderConfig
  ): Promise<void> {
    try {
      if (!providerConfig.apiKey) {
        log.debug(`No API key for provider ${provider}, skipping refresh`);
        return;
      }

      await this.modelCacheService.refreshProvider(provider, {
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseURL,
        timeout: 15000, // 15 second timeout for background refresh
      });

      log.debug(`Successfully refreshed models for provider ${provider} in background`);
    } catch (error) {
      log.debug(`Background model refresh failed for provider ${provider}`, { error });
      // Don't throw - this is a background operation
    }
  }

  /**
   * Transform Vercel AI SDK usage to our format
   */
  private transformUsage(usage: any): AIUsage {
    return {
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      cost: usage?.cost,
    };
  }

  /**
   * Map Vercel AI SDK finish reason to our format
   */
  private mapFinishReason(reason: string): "stop" | "length" | "tool-calls" | "error" {
    const reasonMap: Record<string, "stop" | "length" | "tool-calls" | "error"> = {
      stop: "stop",
      length: "length",
      "tool-calls": "tool-calls",
      error: "error",
      unknown: "stop",
    };

    return reasonMap[reason] || "stop";
  }

  /**
   * Transform errors to our error types
   */
  private transformError(error: unknown, provider?: string, model?: string): Error {
    if (error instanceof AICompletionError || error instanceof AIProviderError) {
      return error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const resolvedProvider = provider || "unknown";
    const resolvedModel = model || "unknown";

    // Check for common error patterns
    if (errorMessage.includes("API key") || errorMessage.includes("authentication")) {
      return new AIProviderError(
        `Authentication failed for ${resolvedProvider}: ${errorMessage}`,
        resolvedProvider,
        "AUTHENTICATION_ERROR",
        { originalError: error }
      );
    }

    if (errorMessage.includes("rate limit") || errorMessage.includes("quota")) {
      return new AIProviderError(
        `Rate limit exceeded for ${resolvedProvider}: ${errorMessage}`,
        resolvedProvider,
        "RATE_LIMIT_ERROR",
        { originalError: error }
      );
    }

    if (errorMessage.includes("model") && errorMessage.includes("not found")) {
      return new AICompletionError(
        `Model ${resolvedModel} not found for provider ${resolvedProvider}: ${errorMessage}`,
        resolvedProvider,
        resolvedModel,
        "MODEL_NOT_FOUND",
        { originalError: error }
      );
    }

    // Generic completion error
    return new AICompletionError(
      `AI completion failed: ${errorMessage}`,
      resolvedProvider,
      resolvedModel,
      "COMPLETION_ERROR",
      { originalError: error }
    );
  }
}
