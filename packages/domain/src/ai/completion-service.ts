/**
 * AI Completion Service
 *
 * Core service for multi-provider AI completions using Vercel AI SDK.
 * Supports OpenAI, Anthropic, Google, and other providers with unified interface.
 */

import { injectable } from "tsyringe";
import { generateText, streamText, generateObject, jsonSchema, LanguageModel } from "ai";
import { z } from "zod";

import {
  AICompletionService,
  AICompletionRequest,
  AICompletionResponse,
  AIModel,
  AIObjectGenerationRequest,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from "./types";
import { DefaultAIConfigurationService, type AnyConfigService } from "./config-service";
import { DefaultModelCacheService } from "./model-cache";
import { createModelCacheServiceWithFetchers } from "./service-factory";
import { resolveLanguageModel, withCallerTemperatureOnly } from "./provider-model-factory";
import {
  getPrimaryModels,
  getFallbackModels,
  refreshProviderModelsInBackground,
} from "./model-catalog";
import { transformUsage, mapFinishReason, transformError } from "./completion-transforms";
import { log } from "@minsky/shared/logger";

/**
 * Injectable seam over the Vercel AI SDK's top-level functions (mt#3622).
 *
 * Defaults to the real "ai" package exports; tests supply fakes here instead
 * of `spyOn`-patching the "ai" module's namespace object, so interception no
 * longer depends on Bun's ESM live-binding semantics keeping a named import
 * and its namespace-object property aliased to the same export slot.
 */
export interface AICompletionServiceDeps {
  generateText: typeof generateText;
  streamText: typeof streamText;
  generateObject: typeof generateObject;
}

const defaultAICompletionServiceDeps: AICompletionServiceDeps = {
  generateText,
  streamText,
  generateObject,
};

/**
 * Default AI completion service implementation
 */
@injectable()
export class DefaultAICompletionService implements AICompletionService {
  private configService: DefaultAIConfigurationService;
  private providerModels: Map<string, LanguageModel> = new Map();
  private modelCacheService: DefaultModelCacheService;
  private readonly deps: AICompletionServiceDeps;

  constructor(configurationService: AnyConfigService, deps: Partial<AICompletionServiceDeps> = {}) {
    this.configService = new DefaultAIConfigurationService(configurationService);

    // Register every fetcher the registry declares, rather than a hardcoded
    // pair. This used to construct OpenAI + Anthropic directly, which meant
    // PROVIDER_FETCHER_REGISTRY and this constructor were two independent
    // sources of truth: a fetcher added to the registry was silently absent
    // here (mt#3337).
    this.modelCacheService = createModelCacheServiceWithFetchers();
    this.deps = { ...defaultAICompletionServiceDeps, ...deps };
  }

  /**
   * Resolve the model for a request, stripping `temperature` when the caller
   * did not ask for one.
   *
   * mt#2733 stopped this service from FABRICATING a temperature, but the AI SDK
   * re-inserts `temperature: 0` downstream of our call arguments, so omission
   * alone never reached the provider (mt#2735). `withCallerTemperatureOnly`
   * removes it at the only layer that runs late enough, and takes the caller's
   * original intent so an EXPLICIT value — including an explicit `0` — still
   * reaches the model unchanged.
   */
  private async resolveModelForRequest(request: {
    provider?: string;
    model?: string;
    temperature?: number;
  }): Promise<LanguageModel> {
    const model = await resolveLanguageModel(
      this.configService,
      this.providerModels,
      request.provider,
      request.model
    );

    return withCallerTemperatureOnly(model, request.temperature);
  }

  /**
   * Generate a complete response from AI provider
   */
  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    try {
      const model = await this.resolveModelForRequest(request);
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

      const result = await this.deps.generateText({
        model,
        prompt: request.prompt,
        system: request.systemPrompt,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // Conditional, matching `temperature` above and `generateObject` below (mt#4314
        // PR #3156 R1). This path always SET the key, so an unset cap reached the SDK as
        // `maxTokens: undefined` — the same shape mt#2733 recorded as being read downstream
        // as a value rather than an absence.
        //
        // `system`, `tools` and `maxSteps` below are still unconditional. Same shape, and
        // deliberately NOT changed here: mt#2733 converged `temperature` on evidence and
        // this converges `maxTokens` on evidence, whereas flipping the rest would be an
        // unmeasured behaviour change to fields nothing in this task exercises.
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
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
          arguments: call.args as Record<string, unknown>,
          result: (call as Record<string, unknown>).result,
        })),
        steps: result.steps?.map((step) => ({
          type: step.toolCalls ? "tool-call" : "text",
          content: step.text,
          toolCalls: step.toolCalls?.map((call) => ({
            id: call.toolCallId,
            name: call.toolName,
            arguments: call.args as Record<string, unknown>,
            result: (call as Record<string, unknown>).result,
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
      const model = await this.resolveModelForRequest(request);

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

      const streamResult = this.deps.streamText({
        model,
        prompt: request.prompt,
        system: request.systemPrompt,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // Conditional, matching `temperature` above and `generateObject` below (mt#4314
        // PR #3156 R1). This path always SET the key, so an unset cap reached the SDK as
        // `maxTokens: undefined` — the same shape mt#2733 recorded as being read downstream
        // as a value rather than an absence.
        //
        // `system`, `tools` and `maxSteps` below are still unconditional. Same shape, and
        // deliberately NOT changed here: mt#2733 converged `temperature` on evidence and
        // this converges `maxTokens` on evidence, whereas flipping the rest would be an
        // unmeasured behaviour change to fields nothing in this task exercises.
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
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
          arguments: call.args as Record<string, unknown>,
          result: (call as Record<string, unknown>).result,
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
  async generateObject(request: AIObjectGenerationRequest): Promise<unknown> {
    try {
      const model = await this.resolveModelForRequest(request);

      log.debug("Starting AI object generation", {
        provider: request.provider,
        model: request.model,
        hasSchema: !!request.schema,
      });

      // AI SDK v4's built-in Zod→JSON-Schema path predates Zod v4's internal
      // restructure and silently emits `{type: "string"}` for any `z.object(...)`,
      // which Anthropic rejects. Convert explicitly with Zod v4's native
      // `z.toJSONSchema` and wrap in the AI SDK's `jsonSchema()` helper.
      // Target draft-07 (Anthropic's expected dialect); cast is required because
      // Zod v4's emitted `JSONSchema` allows `exclusiveMaximum: number | boolean`
      // (draft-04 compat) while AI SDK's `JSONSchema7Definition` restricts it to
      // `number`. The runtime shape is fine either way.
      const schemaJson = z.toJSONSchema(request.schema, { target: "draft-07" });
      const result = await this.deps.generateObject({
        model,
        messages: request.messages as import("ai").CoreMessage[],
        schema: jsonSchema(schemaJson as Record<string, unknown>),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // mt#4314: this line was missing. `maxTokens` is declared on
        // `AIObjectGenerationRequest` and forwarded by `generateText` and `streamText`
        // above — only this path dropped it, so a caller's cap typechecked, looked
        // honored, and never reached the provider. Two production callers had been
        // passing one since they were written.
        //
        // Conditional-spread rather than the siblings' unconditional `maxTokens:
        // request.maxTokens`, matching the `temperature` treatment one line up: mt#2733
        // is this file's record of an unset field forwarded as `undefined` being read
        // downstream as a value. Omitting the key when unset cannot reproduce that class.
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        // mt#4317: the structured-output strategy. Conditional for the same reason as the two
        // fields above — omitted means the SDK's own default ("auto"), which is what every
        // caller got before this existed, so adding the field changes nothing for a caller
        // that does not set it.
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
      });

      // Post-parse validation: the AI may return a shape the JSON Schema
      // tolerates but the original Zod schema rejects (e.g. out-of-range
      // values constrained via .refine()). Validate against the original
      // Zod schema so callers get a type-safe, shape-verified value.
      return request.schema.parse(result.object);
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
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

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
