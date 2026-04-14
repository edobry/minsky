/**
 * AI Provider Commands
 *
 * Registers ai.providers.list and ai.validate commands.
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
import {
  requireAIProviders,
  testProviderConnectivity,
  getProviderStatuses,
} from "../../../../domain/ai/provider-operations";
import { getResolvedConfig } from "./shared";

/**
 * Register AI provider and validate commands
 */
export function registerProviderCommands(): void {
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
}
