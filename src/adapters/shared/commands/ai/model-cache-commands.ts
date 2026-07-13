/**
 * AI Model Cache Commands
 *
 * Registers the ai.models.available, ai.models.refresh, ai.models.list,
 * and ai.cache.clear shared commands.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import {
  createCompletionService,
  createModelCacheServiceWithFetchers,
} from "@minsky/domain/ai/service-factory";
import { requireAIProviders } from "@minsky/domain/ai/provider-operations";
import { getResolvedConfig } from "./shared-helpers";
import { buildModelsAvailableResult, buildModelsListResult } from "./result-builders";

/**
 * Register AI model-cache shared commands
 * (models.available, models.refresh, models.list, cache.clear)
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
      // mt#2727: return structured data; CLI listing rendering lives in
      // src/adapters/cli/customizations/ai-customizations.ts.
      const { provider, format, json } = params;

      const config = getResolvedConfig();
      requireAIProviders(config);

      const completionService = createCompletionService(config);
      const models = await completionService.getAvailableModels(provider as string | undefined);

      return buildModelsAvailableResult({
        provider,
        models,
        json: !!json,
        format: json ? "json" : (format ?? "table"),
      });
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
      // mt#2727: return structured data instead of only printing via log.cli.
      const { provider, force } = params;

      const config = getResolvedConfig();
      const aiConfig = requireAIProviders(config);

      const { createConfigService } = await import("@minsky/domain/ai/service-factory");
      const configService = createConfigService(config);
      const cacheService = createModelCacheServiceWithFetchers();

      const { refreshSingleProvider, refreshAllProviders } = await import(
        "@minsky/domain/ai/provider-operations"
      );

      if (provider) {
        await refreshSingleProvider(configService, cacheService, provider, !!force);
        return { success: true, provider, refreshedCount: 1, errors: [] as string[] };
      }

      const result = await refreshAllProviders(configService, cacheService, aiConfig, !!force);

      return {
        success: result.errors.length === 0,
        provider: null,
        refreshedCount: result.successCount,
        errors: result.errors,
      };
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
      // mt#2727: return structured data; CLI table/yaml rendering lives in
      // src/adapters/cli/customizations/ai-customizations.ts.
      const { provider, format, showCache, json } = params;

      const cacheService = createModelCacheServiceWithFetchers();
      const allModels = await cacheService.getAllCachedModels();

      const modelsToShow = provider ? { [provider]: allModels[provider] || [] } : allModels;

      const cacheMetadata = showCache ? await cacheService.getCacheMetadata() : undefined;

      return buildModelsListResult({
        models: modelsToShow,
        json: !!json,
        format: json ? "json" : (format ?? "table"),
        showCache: !!showCache,
        cacheMetadata,
      });
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
      // mt#2727: return structured data instead of only printing via log.cli.
      const { provider, confirm } = params;

      const cacheService = createModelCacheServiceWithFetchers();
      const target = provider ? `provider '${provider}'` : "all providers";

      if (!confirm) {
        return { success: false, cleared: false, target, needsConfirm: true };
      }

      if (provider) {
        await cacheService.clearProviderCache(provider);
      } else {
        await cacheService.clearAllCache();
      }

      return { success: true, cleared: true, target, needsConfirm: false };
    },
  });
}
