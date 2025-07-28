/**
 * AI Commands for Shared Command System
 *
 * Provides AI completion capabilities using direct configuration access
 * instead of the AIConfigurationService abstraction.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../command-registry";
import { DefaultAICompletionService } from "../../../domain/ai/completion-service";
import { log } from "../../../utils/logger";
import { getConfiguration } from "../../../domain/configuration";
import { exit } from "../../../utils/process";
import type { ResolvedConfig } from "../../../domain/configuration/types";

/**
 * Parameters for AI completion command
 */
const aiCompleteParams: CommandParameterMap = {
  prompt: {
    schema: z.string().min(1),
    description: "The prompt to complete",
    required: true,
  },
  model: {
    schema: z.string(),
    description: "AI model to use",
    required: false,
  },
  provider: {
    schema: z.string(),
    description: "AI provider to use",
    required: false,
  },
  temperature: {
    schema: z.number().min(0).max(1),
    description: "Completion temperature (0-1)",
    required: false,
  },
  maxTokens: {
    schema: z.number().min(1),
    description: "Maximum tokens to generate",
    required: false,
  },
  stream: {
    schema: z.boolean(),
    description: "Stream the response",
    required: false,
    defaultValue: false,
  },
  system: {
    schema: z.string(),
    description: "System prompt",
    required: false,
  },
};

/**
 * Register all AI-related shared commands
 */
export function registerAiCommands(): void {
  // Register AI completion command
  sharedCommandRegistry.registerCommand({
    id: "ai:complete",
    category: CommandCategory.CORE,
    name: "complete",
    description: "Generate AI completion for a prompt",
    parameters: aiCompleteParams,
    execute: async (params, context) => {
      try {
        const { prompt, model, provider, temperature, maxTokens, stream, system } = params;

        // Get AI configuration directly from the unified config system
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        // Create AI completion service with direct config access
        const completionService = new DefaultAICompletionService(aiConfig);

        const request = {
          prompt,
          model,
          provider,
          temperature,
          maxTokens,
          stream,
          systemPrompt: system,
        };

        if (request.stream) {
          // Handle streaming response
          for await (const response of completionService.stream(request)) {
            await Bun.write(Bun.stdout, response.content);
          }
          await Bun.write(Bun.stdout, "\n");
        } else {
          // Handle non-streaming response
          const response = await completionService.complete(request);
          await Bun.write(Bun.stdout, `${response.content}\n`);

          // Show usage info
          if (response.usage) {
            log.info(
              `Usage: ${response.usage.totalTokens} tokens (${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion)`
            );
            if (response.usage.cost) {
              log.info(`Cost: $${response.usage.cost.toFixed(4)}`);
            }
          }
        }
      } catch (error) {
        log.cliError(
          `AI completion failed: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI chat command
  sharedCommandRegistry.registerCommand({
    id: "ai:chat",
    category: CommandCategory.CORE,
    name: "chat",
    description: "Start an interactive AI chat session",
    parameters: {
      model: {
        schema: z.string(),
        description: "AI model to use",
        required: false,
      },
      provider: {
        schema: z.string(),
        description: "AI provider to use",
        required: false,
      },
      system: {
        schema: z.string(),
        description: "System prompt",
        required: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { model, provider, system } = params;

        // Get AI configuration directly
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const completionService = new DefaultAICompletionService(aiConfig);

        // For now, chat is not implemented due to readline complexity in Bun
        log.cliError("Interactive chat is not yet implemented. Use 'minsky ai complete' instead.");
        exit(1);
      } catch (error) {
        log.cliError(
          `Chat session failed: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI models command
  sharedCommandRegistry.registerCommand({
    id: "ai:models",
    category: CommandCategory.CORE,
    name: "models",
    description: "List available AI models",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Filter by provider",
        required: false,
      },
      format: {
        schema: z.string(),
        description: "Output format (table|json)",
        required: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, format } = params;

        // Get AI configuration directly
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const completionService = new DefaultAICompletionService(aiConfig);
        const models = await completionService.getAvailableModels(provider as string | undefined);

        if (format === "json") {
          log.cli(JSON.stringify(models, null, 2));
        } else {
          // Table format
          log.cli("AVAILABLE AI MODELS");
          log.cli("=".repeat(50));

          for (const model of models) {
            log.cli(`\nModel: ${model.name}`);
            log.cli(`  ID: ${model.id}`);
            log.cli(`  Provider: ${model.provider}`);
            log.cli(`  Context Window: ${model.contextWindow.toLocaleString()} tokens`);
            log.cli(`  Max Output: ${model.maxOutputTokens.toLocaleString()} tokens`);

            if (model.costPer1kTokens) {
              log.cli(
                `  Cost: $${model.costPer1kTokens.input}/1k input, $${model.costPer1kTokens.output}/1k output`
              );
            }

            if (model.description) {
              log.cli(`  Description: ${model.description}`);
            }

            if (model.capabilities.length > 0) {
              const caps = model.capabilities.map((c) => c.name).join(", ");
              log.cli(`  Capabilities: ${caps}`);
            }
          }
        }
      } catch (error) {
        log.cliError(
          `Failed to list models: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI validate command
  sharedCommandRegistry.registerCommand({
    id: "ai:validate",
    category: CommandCategory.CORE,
    name: "AI Validate",
    description: "Validate AI configuration and test connectivity",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Validate specific provider only",
        required: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider } = params;

        // Get AI configuration directly
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const completionService = new DefaultAICompletionService(aiConfig);
        const result = await completionService.validateConfiguration();

        if (result.valid) {
          log.cliSuccess("AI configuration is valid!");

          // Test each provider if no specific provider requested
          const providersToTest = provider ? [provider] : Object.keys(aiConfig.providers || {});

          for (const providerName of providersToTest) {
            const providerConfig = aiConfig.providers?.[providerName];
            if (providerConfig?.api_key) {
              try {
                log.cli(`Testing ${providerName}...`);
                await completionService.complete({
                  prompt: "Hello",
                  provider: providerName,
                  maxTokens: 5,
                });
                log.cliSuccess(`✓ ${providerName} connection successful`);
              } catch (error) {
                log.cliError(
                  `✗ ${providerName} connection failed: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            } else {
              log.cliWarning(`⚠ ${providerName} not configured (missing API key)`);
            }
          }
        } else {
          log.cliError("AI configuration is invalid:");
          for (const error of result.errors) {
            log.cliError(`  - ${error.field}: ${error.message}`);
          }

          for (const warning of result.warnings) {
            log.cliWarning(`  - ${warning.field}: ${warning.message}`);
          }
          exit(1);
        }
      } catch (error) {
        log.cliError(
          `Validation failed: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Initialize model cache service instance
  const createModelCacheService = () => {
    const cacheService = new DefaultModelCacheService();

    // Register fetchers
    cacheService.registerFetcher(new OpenAIModelFetcher());
    cacheService.registerFetcher(new AnthropicModelFetcher());

    return cacheService;
  };

  // Register AI models refresh command
  sharedCommandRegistry.registerCommand({
    id: "ai:models:refresh",
    category: CommandCategory.CORE,
    name: "AI Models Refresh",
    description: "Refresh cached model data from provider APIs",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Specific provider to refresh (optional)",
        required: false,
      },
      force: {
        schema: z.boolean(),
        description: "Force refresh even if cache is fresh",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, force } = params;

        // Get AI configuration
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const configService = new DefaultAIConfigurationService({
          loadConfiguration: () => Promise.resolve({ resolved: config }),
        } as any);
        const cacheService = createModelCacheService();

        if (provider) {
          // Refresh specific provider
          const providerConfig = await configService.getProviderConfig(provider);
          if (!providerConfig) {
            log.cliError(`Provider '${provider}' is not configured.`);
            exit(1);
          }

          if (!force && !(await cacheService.isCacheStale(provider))) {
            log.info(
              `Cache for provider '${provider}' is still fresh. Use --force to refresh anyway.`
            );
            return;
          }

          log.info(`Refreshing models for provider: ${provider}`);
          await cacheService.refreshProvider(provider, {
            apiKey: providerConfig.apiKey!,
            baseURL: providerConfig.baseURL,
          });
          log.success(`✓ Successfully refreshed models for ${provider}`);
        } else {
          // Refresh all providers
          const providerConfigs: Record<string, any> = {};
          const configuredProviders = Object.keys(aiConfig.providers || {});

          for (const providerName of configuredProviders) {
            const providerConfig = await configService.getProviderConfig(providerName);
            if (providerConfig && providerConfig.apiKey) {
              if (force || (await cacheService.isCacheStale(providerName))) {
                providerConfigs[providerName] = {
                  apiKey: providerConfig.apiKey,
                  baseURL: providerConfig.baseURL,
                };
              }
            }
          }

          if (Object.keys(providerConfigs).length === 0) {
            log.info("All provider caches are fresh. Use --force to refresh anyway.");
            return;
          }

          log.info(`Refreshing models for ${Object.keys(providerConfigs).length} providers...`);
          await cacheService.refreshAllProviders(providerConfigs);
          log.success(`✓ Successfully refreshed models for all providers`);
        }
      } catch (error) {
        log.cliError(
          `Failed to refresh models: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI models list command (enhanced version)
  sharedCommandRegistry.registerCommand({
    id: "ai:models:list",
    category: CommandCategory.CORE,
    name: "AI Models List",
    description: "List cached AI models with detailed information",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Filter by provider",
        required: false,
      },
      format: {
        schema: z.string(),
        description: "Output format (table|json|yaml)",
        required: false,
        defaultValue: "table",
      },
      showCache: {
        schema: z.boolean(),
        description: "Show cache metadata",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, format, showCache } = params;

        const cacheService = createModelCacheService();
        const allModels = await cacheService.getAllCachedModels();

        let modelsToShow = allModels;
        if (provider) {
          modelsToShow = { [provider]: allModels[provider] || [] };
        }

        if (format === "json") {
          log.cli(JSON.stringify(modelsToShow, null, 2));
        } else if (format === "yaml") {
          // Simple YAML-like output
          for (const [providerName, models] of Object.entries(modelsToShow)) {
            log.cli(`${providerName}:`);
            for (const model of models) {
              log.cli(`  - id: ${model.id}`);
              log.cli(`    name: ${model.name}`);
              log.cli(`    contextWindow: ${model.contextWindow}`);
              log.cli(`    status: ${model.status}`);
              if (model.costPer1kTokens) {
                log.cli(
                  `    cost: $${model.costPer1kTokens.input}/$${model.costPer1kTokens.output} per 1k tokens`
                );
              }
            }
          }
        } else {
          // Table format
          log.cli("CACHED AI MODELS");
          log.cli("=".repeat(80));

          for (const [providerName, models] of Object.entries(modelsToShow)) {
            if (models.length === 0) {
              log.cli(`\n${providerName.toUpperCase()}: No cached models`);
              continue;
            }

            log.cli(`\n${providerName.toUpperCase()} (${models.length} models):`);
            for (const model of models) {
              log.cli(`  ${model.id}`);
              log.cli(`    Name: ${model.name}`);
              log.cli(`    Context: ${model.contextWindow.toLocaleString()} tokens`);
              log.cli(`    Status: ${model.status}`);
              if (model.costPer1kTokens) {
                log.cli(
                  `    Cost: $${model.costPer1kTokens.input}/1k input, $${model.costPer1kTokens.output}/1k output`
                );
              }
              if (showCache) {
                log.cli(`    Cached: ${model.fetchedAt.toISOString()}`);
              }
              log.cli("");
            }
          }
        }

        if (showCache) {
          const metadata = await cacheService.getCacheMetadata();
          log.cli("\nCACHE METADATA:");
          log.cli(`Last Updated: ${metadata.lastUpdated.toISOString()}`);
          log.cli(`TTL: ${Math.round(metadata.ttl / (1000 * 60 * 60))} hours`);
          log.cli(`Next Refresh: ${metadata.nextRefresh.toISOString()}`);
        }
      } catch (error) {
        log.cliError(
          `Failed to list models: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI providers list command
  sharedCommandRegistry.registerCommand({
    id: "ai:providers:list",
    category: CommandCategory.CORE,
    name: "AI Providers List",
    description: "List configured AI providers and their cache status",
    parameters: {
      format: {
        schema: z.string(),
        description: "Output format (table|json)",
        required: false,
        defaultValue: "table",
      },
    },
    execute: async (params, context) => {
      try {
        const { format } = params;

        // Get AI configuration
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured.");
          exit(1);
        }

        const configService = new DefaultAIConfigurationService({
          loadConfiguration: () => Promise.resolve({ resolved: config }),
        } as any);
        const cacheService = createModelCacheService();
        const metadata = await cacheService.getCacheMetadata();

        const providers = [];
        for (const providerName of Object.keys(aiConfig.providers)) {
          const providerConfig = await configService.getProviderConfig(providerName);
          const providerMetadata = metadata.providers[providerName];
          const isStale = await cacheService.isCacheStale(providerName);

          providers.push({
            name: providerName,
            configured: !!providerConfig,
            hasApiKey: !!providerConfig?.apiKey,
            lastFetched: providerMetadata?.lastFetched?.toISOString(),
            modelCount: providerMetadata?.modelCount || 0,
            lastSuccess: providerMetadata?.lastFetchSuccessful ?? null,
            isStale,
            error: providerMetadata?.lastError,
          });
        }

        if (format === "json") {
          log.cli(JSON.stringify(providers, null, 2));
        } else {
          // Table format
          log.cli("CONFIGURED AI PROVIDERS");
          log.cli("=".repeat(60));

          for (const provider of providers) {
            const status = !provider.hasApiKey
              ? "❌ No API Key"
              : provider.lastSuccess === false
                ? "❌ Error"
                : provider.isStale
                  ? "⚠️  Cache Stale"
                  : "✅ Ready";

            log.cli(`\n${provider.name.toUpperCase()}`);
            log.cli(`  Status: ${status}`);
            log.cli(`  Models Cached: ${provider.modelCount}`);
            if (provider.lastFetched) {
              log.cli(`  Last Fetched: ${new Date(provider.lastFetched).toLocaleString()}`);
            }
            if (provider.error) {
              log.cli(`  Error: ${provider.error}`);
            }
          }
        }
      } catch (error) {
        log.cliError(
          `Failed to list providers: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI cache clear command
  sharedCommandRegistry.registerCommand({
    id: "ai:cache:clear",
    category: CommandCategory.CORE,
    name: "AI Cache Clear",
    description: "Clear cached model data",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Specific provider to clear (optional)",
        required: false,
      },
      confirm: {
        schema: z.boolean(),
        description: "Skip confirmation prompt",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, confirm } = params;

        const cacheService = createModelCacheService();

        if (!confirm) {
          const target = provider ? `provider '${provider}'` : "all providers";
          log.cli(`This will clear cached model data for ${target}.`);
          log.cli("Use --confirm to proceed without this prompt.");
          return;
        }

        if (provider) {
          await cacheService.clearProviderCache(provider);
          log.success(`✓ Cleared cache for provider: ${provider}`);
        } else {
          await cacheService.clearAllCache();
          log.success("✓ Cleared all cached model data");
        }
      } catch (error) {
        log.cliError(
          `Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });
}
