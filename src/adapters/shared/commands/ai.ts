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
  type CommandParameterMap,
} from "../command-registry";
import { log } from "../../../utils/logger";
import { getConfiguration } from "../../../domain/configuration";
import { exit } from "../../../utils/process";
import type { ResolvedConfig } from "../../../domain/configuration/types";
import {
  createCompletionService,
  createConfigService,
  createModelCacheServiceWithFetchers,
} from "../../../domain/ai/service-factory";
import { executeFastApply } from "../../../domain/ai/fast-apply-service";
import { getErrorMessage } from "../../../domain/ai/error-utils";
import {
  requireAIProviders,
  testProviderConnectivity,
  refreshSingleProvider,
  refreshAllProviders,
  getProviderStatuses,
} from "../../../domain/ai/provider-operations";

/**
 * Get resolved configuration, cast to ResolvedConfig for domain service
 * compatibility. The Configuration type from zod inference is structurally
 * compatible but not assignable due to optional vs required field differences.
 */
function getResolvedConfig(): ResolvedConfig {
  return getConfiguration() as unknown as ResolvedConfig;
}

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
 * Parameters for fast-apply command
 */
const aiFastApplyParams: CommandParameterMap = {
  filePath: {
    schema: z.string().min(1),
    description: "Path to the file to edit",
    required: true,
  },
  instructions: {
    schema: z.string().min(1),
    description: "Description of what changes to make",
    required: false,
  },
  codeEdit: {
    schema: z.string().min(1),
    description: "New code with '// ... existing code ...' markers (Cursor format)",
    required: false,
  },
  provider: {
    schema: z.string(),
    description: "Fast-apply provider to use (defaults to auto-detect)",
    required: false,
  },
  model: {
    schema: z.string(),
    description: "Model to use for fast-apply",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Show the proposed changes without applying them",
    required: false,
  },
};

/**
 * Register all AI-related shared commands
 */
export function registerAiCommands(): void {
  // Register AI completion command
  sharedCommandRegistry.registerCommand({
    id: "ai.complete",
    category: CommandCategory.AI,
    name: "complete",
    description: "Generate AI completion for a prompt",
    parameters: aiCompleteParams,
    execute: async (params, context) => {
      try {
        const { prompt, model, provider, temperature, maxTokens, stream, system } = params;

        const config = getResolvedConfig();
        requireAIProviders(config);

        const completionService = createCompletionService(config);

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
          for await (const response of completionService.stream(request)) {
            await Bun.write(Bun.stdout, response.content);
          }
          await Bun.write(Bun.stdout, "\n");
        } else {
          const response = await completionService.complete(request);
          await Bun.write(Bun.stdout, `${response.content}\n`);

          if (response.usage) {
            log.info(
              `Usage: ${response.usage.totalTokens} tokens ` +
                `(${response.usage.promptTokens} prompt + ` +
                `${response.usage.completionTokens} completion)`
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

  // Register AI fast-apply command
  sharedCommandRegistry.registerCommand({
    id: "ai.fast-apply",
    category: CommandCategory.AI,
    name: "fast-apply",
    description:
      "Apply fast edits to a file using fast-apply models " +
      "(supports both instruction and Cursor edit pattern modes)",
    parameters: aiFastApplyParams,
    execute: async (params, context) => {
      try {
        const { filePath, instructions, codeEdit, provider, model, dryRun } = params;

        if (!instructions && !codeEdit) {
          log.cliError("Either 'instructions' or 'codeEdit' parameter must be provided");
          exit(1);
        }

        const fs = await import("fs/promises");

        let originalContent: string;
        try {
          originalContent = (await fs.readFile(filePath, "utf-8")) as string;
        } catch (error) {
          log.cliError(
            `Failed to read file ${filePath}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
          exit(1);
        }

        const config = getResolvedConfig();
        requireAIProviders(config);

        const result = await executeFastApply(config, {
          filePath,
          originalContent: originalContent!,
          instructions,
          codeEdit,
          provider,
          model,
        });

        if (dryRun) {
          log.cli("🔍 Dry run - showing proposed changes:");
          log.cli("\n--- Original ---");
          log.cli(originalContent!);
          log.cli("\n--- Edited ---");
          log.cli(result.editedContent);
          log.cli(
            `\nTokens used: ${result.response.usage.totalTokens} ` +
              `(${result.response.usage.promptTokens} prompt + ` +
              `${result.response.usage.completionTokens} completion)`
          );
          if (result.response.usage.cost) {
            log.cli(`Cost: $${result.response.usage.cost.toFixed(4)}`);
          }
        } else {
          await fs.writeFile(filePath, result.editedContent, "utf-8");
          log.cli(`✅ Successfully applied edits to ${filePath}`);
          log.info(
            `Tokens used: ${result.response.usage.totalTokens} ` +
              `(${result.response.usage.promptTokens} prompt + ` +
              `${result.response.usage.completionTokens} completion)`
          );
          if (result.response.usage.cost) {
            log.info(`Cost: $${result.response.usage.cost.toFixed(4)}`);
          }
        }
      } catch (error) {
        log.cliError(
          `Fast-apply failed: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI chat command
  sharedCommandRegistry.registerCommand({
    id: "ai.chat",
    category: CommandCategory.AI,
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
        const config = getResolvedConfig();
        requireAIProviders(config);

        log.cliError(
          "Interactive chat is not yet implemented. " + "Use 'minsky ai complete' instead."
        );
        exit(1);
      } catch (error) {
        log.cliError(
          `Chat session failed: ` + `${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI models available command
  sharedCommandRegistry.registerCommand({
    id: "ai.models.available",
    category: CommandCategory.AI,
    name: "available",
    description: "List available AI models from providers",
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
      json: {
        schema: z.boolean(),
        description: "Output in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, format, json } = params;
        const outputFormat = json ? "json" : format;

        const config = getResolvedConfig();
        requireAIProviders(config);

        const completionService = createCompletionService(config);
        const models = await completionService.getAvailableModels(provider as string | undefined);

        if (models.length === 0) {
          if (provider) {
            log.cliWarn(`No models available for provider '${provider}'. This may be because:`);
            log.cliWarn("  - The provider doesn't support model listing");
            log.cliWarn("  - The API key is not configured or invalid");
            log.cliWarn("  - The provider name is incorrect");
          } else {
            log.cliWarn("No models available from any configured providers.");
            log.cliWarn("This may be because:");
            log.cliWarn("  - No API keys are configured");
            log.cliWarn("  - Providers don't support model listing");
            log.cliWarn("  - Network connectivity issues");
            log.cli(
              "\nTo configure providers, see: " +
                "https://github.com/edobry/minsky#ai-completion-backend"
            );
          }
          return;
        }

        if (outputFormat === "json") {
          log.cli(JSON.stringify(models, null, 2));
        } else {
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
                `  Cost: $${model.costPer1kTokens.input}/1k input, ` +
                  `$${model.costPer1kTokens.output}/1k output`
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
        log.cliError(`Failed to list models: ${getErrorMessage(error)}`);
        log.cliWarn("This may be due to:");
        log.cliWarn("  - Network connectivity issues");
        log.cliWarn("  - Invalid API keys");
        log.cliWarn("  - Provider service unavailable");
        log.cli("\nTry:");
        log.cli("  - Check your internet connection");
        log.cli("  - Verify your API keys are configured correctly");
        log.cli("  - Use 'minsky core ai validate' to test your configuration");
        exit(1);
      }
    },
  });

  // Register AI validate command
  sharedCommandRegistry.registerCommand({
    id: "ai.validate",
    category: CommandCategory.AI,
    name: "validate",
    description: "Validate AI configuration and test connectivity",
    parameters: {
      provider: {
        schema: z.string(),
        description: "Validate specific provider only",
        required: false,
      },
      json: {
        schema: z.boolean(),
        description: "Output validation results in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, json } = params;

        const config = getResolvedConfig();
        const aiConfig = requireAIProviders(config);

        const completionService = createCompletionService(config);
        const result = await completionService.validateConfiguration();

        const validationResults = {
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          providers: [] as Array<{
            name: string;
            configured: boolean;
            hasApiKey: boolean;
            connectionTest: {
              attempted: boolean;
              successful: boolean;
              error?: string;
            };
          }>,
        };

        if (result.valid) {
          const providersToTest = provider ? [provider] : Object.keys(aiConfig.providers || {});

          validationResults.providers = await testProviderConnectivity(
            completionService,
            aiConfig,
            providersToTest,
            { silent: !!json }
          );
        }

        if (json) {
          log.cli(JSON.stringify(validationResults, null, 2));
        } else {
          if (result.valid) {
            log.cli("AI configuration is valid!");
          } else {
            log.cliError("AI configuration is invalid:");
            for (const error of result.errors) {
              log.cliError(`  - ${error.field}: ${error.message}`);
            }

            for (const warning of result.warnings) {
              log.cliWarn(`  - ${warning.field}: ${warning.message}`);
            }
            exit(1);
          }
        }
      } catch (error) {
        log.cliError(
          `Validation failed: ` + `${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI models refresh command
  sharedCommandRegistry.registerCommand({
    id: "ai.models.refresh",
    category: CommandCategory.AI,
    name: "refresh",
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

        const config = getResolvedConfig();
        const aiConfig = requireAIProviders(config);

        const configService = createConfigService(config);
        const cacheService = createModelCacheServiceWithFetchers();

        if (provider) {
          await refreshSingleProvider(configService, cacheService, provider, force);
        } else {
          const result = await refreshAllProviders(configService, cacheService, aiConfig, force);

          if (result.successCount > 0) {
            log.cli(`\n✓ Successfully refreshed ${result.successCount} provider(s)`);
          }

          if (result.errors.length > 0) {
            log.cliWarn(
              `Failed to refresh ${result.errors.length} provider(s): ${result.errors.join(", ")}`
            );
            exit(1);
          }
        }
      } catch (error) {
        log.cliError(`Failed to refresh models: ${getErrorMessage(error)}`);
        exit(1);
      }
    },
  });

  // Register AI models list command
  sharedCommandRegistry.registerCommand({
    id: "ai.models.list",
    category: CommandCategory.AI,
    name: "list",
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
      json: {
        schema: z.boolean(),
        description: "Output in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { provider, format, showCache, json } = params;
        const outputFormat = json ? "json" : format;

        const cacheService = createModelCacheServiceWithFetchers();
        const allModels = await cacheService.getAllCachedModels();

        let modelsToShow = allModels;
        if (provider) {
          modelsToShow = { [provider]: allModels[provider] || [] };
        }

        if (outputFormat === "json") {
          log.cli(JSON.stringify(modelsToShow, null, 2));
        } else if (outputFormat === "yaml") {
          for (const [providerName, models] of Object.entries(modelsToShow)) {
            log.cli(`${providerName}:`);
            for (const model of models) {
              log.cli(`  - id: ${model.id}`);
              log.cli(`    name: ${model.name}`);
              log.cli(`    contextWindow: ${model.contextWindow}`);
              log.cli(`    status: ${model.status}`);
              if (model.costPer1kTokens) {
                log.cli(
                  `    cost: $${model.costPer1kTokens.input}/` +
                    `$${model.costPer1kTokens.output} per 1k tokens`
                );
              }
            }
          }
        } else {
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
                  `    Cost: $${model.costPer1kTokens.input}/1k input, ` +
                    `$${model.costPer1kTokens.output}/1k output`
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
          `Failed to list models: ` + `${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI providers list command
  sharedCommandRegistry.registerCommand({
    id: "ai.providers.list",
    category: CommandCategory.AI,
    name: "list",
    description: "List configured AI providers and their cache status",
    parameters: {
      format: {
        schema: z.string(),
        description: "Output format (table|json)",
        required: false,
        defaultValue: "table",
      },
      json: {
        schema: z.boolean(),
        description: "Output in JSON format",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params, context) => {
      try {
        const { format, json } = params;
        const outputFormat = json ? "json" : format;

        const config = getResolvedConfig();
        const aiConfig = requireAIProviders(config);

        const configService = createConfigService(config);
        const cacheService = createModelCacheServiceWithFetchers();
        const providers = await getProviderStatuses(configService, cacheService, aiConfig);

        if (outputFormat === "json") {
          log.cli(JSON.stringify(providers, null, 2));
        } else {
          log.cli("CONFIGURED AI PROVIDERS");
          log.cli("=".repeat(60));

          for (const provider of providers) {
            const status = !provider.hasApiKey
              ? "🚫 Not Configured"
              : provider.lastSuccess === false
                ? "❌ Error"
                : provider.isStale
                  ? "⚠️  Cache Stale"
                  : "✅ Ready";

            log.cli(`\n${provider.name.toUpperCase()}`);
            log.cli(`  Status: ${status}`);
            log.cli(`  Models Cached: ${provider.modelCount}`);
            if (provider.lastFetched) {
              log.cli(`  Last Fetched: ` + `${new Date(provider.lastFetched).toLocaleString()}`);
            }
            if (provider.error) {
              log.cli(`  Error: ${provider.error}`);
            }
          }
        }
      } catch (error) {
        log.cliError(
          `Failed to list providers: ` + `${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });

  // Register AI cache clear command
  sharedCommandRegistry.registerCommand({
    id: "ai.cache.clear",
    category: CommandCategory.AI,
    name: "clear",
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

        const cacheService = createModelCacheServiceWithFetchers();

        if (!confirm) {
          const target = provider ? `provider '${provider}'` : "all providers";
          log.cli(`This will clear cached model data for ${target}.`);
          log.cli("Use --confirm to proceed without this prompt.");
          return;
        }

        if (provider) {
          await cacheService.clearProviderCache(provider);
          log.cli(`✓ Cleared cache for provider: ${provider}`);
        } else {
          await cacheService.clearAllCache();
          log.cli("✓ Cleared all cached model data");
        }
      } catch (error) {
        log.cliError(
          `Failed to clear cache: ` + `${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });
}
