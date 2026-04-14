/**
 * AI Model Cache Commands
 *
 * Registers ai.models.available, ai.models.refresh, ai.models.list,
 * and ai.cache.clear commands.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import { log } from "../../../../utils/logger";
import { exit } from "../../../../utils/process";
import {
  createCompletionService,
  createConfigService,
  createModelCacheServiceWithFetchers,
} from "../../../../domain/ai/service-factory";
import { getErrorMessage } from "../../../../domain/ai/error-utils";
import {
  requireAIProviders,
  refreshSingleProvider,
  refreshAllProviders,
} from "../../../../domain/ai/provider-operations";
import { getResolvedConfig } from "./shared";

/**
 * Register AI model cache commands
 */
export function registerModelCacheCommands(): void {
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
    execute: async (params, _context) => {
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
    execute: async (params, _context) => {
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
    execute: async (params, _context) => {
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
        log.cliError(`Failed to list models: ${getErrorMessage(error)}`);
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
    execute: async (params, _context) => {
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
        log.cliError(`Failed to clear cache: ${getErrorMessage(error)}`);
        exit(1);
      }
    },
  });
}
