/**
 * AI Completion Service
 *
 * Core service for multi-provider AI completions using Vercel AI SDK.
 * Supports OpenAI, Anthropic, Google, and other providers with unified interface.
 */

import { generateText, streamText, generateObject, LanguageModel } from "ai";

import {
  AICompletionService,
  AICompletionRequest,
  AICompletionResponse,
  AIModel,
  AIProviderError,
  ValidationResult,
} from "./types";
import { DefaultAIConfigurationService } from "./config-service";
import { DefaultModelCacheService, OpenAIModelFetcher, AnthropicModelFetcher } from "./model-cache";
import { resolveLanguageModel } from "./provider-model-factory";
import {
  getPrimaryModels,
  getFallbackModels,
  refreshProviderModelsInBackground,
} from "./model-catalog";
import { transformUsage, mapFinishReason, transformError } from "./completion-transforms";
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
      const model = await resolveLanguageModel(
        this.configService,
        this.providerModels,
        request.provider,
        request.model
      );
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

      return {
        content: result.text,
        model: request.model || "unknown",
        provider: request.provider || "unknown",
        usage: transformUsage(result.usage),
        toolCalls: result.toolCalls?.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.args,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result: (call as any).result,
        })),
        steps: result.steps?.map((step) => ({
          type: step.toolCalls ? "tool-call" : "text",
          content: step.text,
          toolCalls: step.toolCalls?.map((call) => ({
            id: call.toolCallId,
            name: call.toolName,
            arguments: call.args,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result: (call as any).result,
          })),
          usage: transformUsage(step.usage),
        })),
        finishReason: mapFinishReason(result.finishReason),
        metadata: {
          duration,
          modelId: result.experimental_providerMetadata?.modelId,
        },
      };
    } catch (error) {
      log.systemDebug(
        `AI completion failed for provider ${request.provider}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw transformError(error, request.provider, request.model);
    }
  }

  /**
   * Stream AI completion responses
   */
  async *stream(request: AICompletionRequest): AsyncIterable<AICompletionResponse> {
    try {
      const model = await resolveLanguageModel(
        this.configService,
        this.providerModels,
        request.provider,
        request.model
      );

      log.debug("Starting AI streaming completion", {
        provider: request.provider,
        model: request.model,
        hasTools: !!request.tools?.length,
      });

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

      const streamResult = streamText({
        model,
        prompt: request.prompt,
        system: request.systemPrompt,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        tools,
        maxSteps: request.maxSteps,
      });

      for await (const delta of streamResult.textStream) {
        yield {
          content: delta,
          model: request.model || "unknown",
          provider: request.provider || "unknown",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReason: "stop",
          metadata: { streaming: true },
        };
      }

      const finalText = await streamResult.text;
      const usage = await streamResult.usage;

      yield {
        content: finalText,
        model: request.model || "unknown",
        provider: request.provider || "unknown",
        usage: transformUsage(usage),
        toolCalls: (await streamResult.toolCalls)?.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.args,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result: (call as any).result,
        })),
        finishReason: mapFinishReason((await streamResult.finishReason) || "stop"),
        metadata: { streaming: false, final: true },
      };
    } catch (error) {
      log.error("AI streaming completion failed", { error, request });
      throw transformError(error, request.provider, request.model);
    }
  }

  /**
   * Generate structured object using AI provider
   */
  async generateObject(request: any): Promise<any> {
    try {
      const model = await resolveLanguageModel(
        this.configService,
        this.providerModels,
        request.provider,
        request.model
      );

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
      throw transformError(error, request.provider, request.model);
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

      const allModels: AIModel[] = [];
      const defaultProvider = await this.configService.getDefaultProvider();
      const providerConfig = await this.configService.getProviderConfig(defaultProvider);

      if (providerConfig) {
        allModels.push(...(await this.getProviderModels(defaultProvider)));
      }

      return allModels;
    } catch (error) {
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

        try {
          const model = await resolveLanguageModel(
            this.configService,
            this.providerModels,
            defaultProvider
          );
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

      return { valid: errors.length === 0, errors, warnings };
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
   * Get available models for a specific provider using cache service
   */
  private async getProviderModels(provider: string): Promise<AIModel[]> {
    const providerConfig = await this.configService.getProviderConfig(provider);

    if (!providerConfig) {
      return [];
    }

    try {
      const cachedModels = await this.modelCacheService.getCachedModels(provider);

      if (cachedModels.length > 0) {
        if (await this.modelCacheService.isCacheStale(provider)) {
          refreshProviderModelsInBackground(provider, providerConfig, this.modelCacheService);
        }

        return cachedModels.map((m) => ({
          id: m.id,
          provider: m.provider,
          name: m.name,
          description: m.description,
          capabilities: m.capabilities,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          costPer1kTokens: m.costPer1kTokens,
        }));
      }

      if (providerConfig.apiKey) {
        log.debug(`No cached models for ${provider}, attempting fresh fetch`);
        await refreshProviderModelsInBackground(provider, providerConfig, this.modelCacheService);

        const refreshedModels = await this.modelCacheService.getCachedModels(provider);
        if (refreshedModels.length > 0) {
          return refreshedModels.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            description: m.description,
            capabilities: m.capabilities,
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
            costPer1kTokens: m.costPer1kTokens,
          }));
        }
      }

      return getPrimaryModels(provider, providerConfig) ?? [];
    } catch (error) {
      log.warn(`Failed to get models for provider ${provider}, falling back to minimal set`, {
        error,
      });
      return getFallbackModels(provider, providerConfig);
    }
  }
}
