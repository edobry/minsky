/**
 * AI Provider Commands
 *
 * Registers the ai.validate and ai.providers.list shared commands.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import {
  createCompletionService,
  createConfigService,
  createModelCacheServiceWithFetchers,
} from "@minsky/domain/ai/service-factory";
import {
  requireAIProviders,
  testProviderConnectivity,
  getProviderStatuses,
} from "@minsky/domain/ai/provider-operations";
import { getResolvedConfig } from "./shared-helpers";
import { buildValidateResult, buildProvidersListResult } from "./result-builders";

/**
 * Register AI provider shared commands (validate, providers.list)
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
    execute: async (params, _context) => {
      // mt#2727: return structured data — never print via log.cli/exit()
      // here. MCP serializes this return value directly; CLI rendering
      // (including the invalid-config exit(1)) lives in
      // src/adapters/cli/customizations/ai-customizations.ts.
      const { provider, json } = params;

      const config = getResolvedConfig();
      const aiConfig = requireAIProviders(config);

      const completionService = createCompletionService(config);
      const result = await completionService.validateConfiguration();

      const providers = result.valid
        ? await testProviderConnectivity(
            completionService,
            aiConfig,
            provider ? [provider] : Object.keys(aiConfig.providers || {}),
            { silent: !!json }
          )
        : [];

      return buildValidateResult({
        valid: result.valid,
        json: !!json,
        errors: result.errors,
        warnings: result.warnings,
        providers,
      });
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
    execute: async (params, _context) => {
      // mt#2727: return structured data; CLI table rendering lives in
      // src/adapters/cli/customizations/ai-customizations.ts.
      const { format, json } = params;

      const config = getResolvedConfig();
      const aiConfig = requireAIProviders(config);

      const configService = createConfigService(config);
      const cacheService = createModelCacheServiceWithFetchers();
      const providers = await getProviderStatuses(configService, cacheService, aiConfig);

      return buildProvidersListResult(providers, !!json, json ? "json" : (format ?? "table"));
    },
  });
}
