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
import { DefaultAIConfigurationService } from "../../../domain/ai/config-service";
import {
  DefaultModelCacheService,
  OpenAIModelFetcher,
  AnthropicModelFetcher,
} from "../../../domain/ai/model-cache";
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
    description: "Instructions for how to edit the file",
    required: true,
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
 * Helper function to handle refresh errors with user-friendly messages
 */
function handleRefreshError(provider: string, error: any): void {
  const errorMessage = getErrorMessage(error);

  // Handle specific known error cases
  if (errorMessage.includes("HTTP 404") || errorMessage.includes("Not Found")) {
    if (provider === "anthropic") {
      log.cliWarn(
        `⚠️  ${provider}: API endpoint not found - this provider may not support model listing`
      );
    } else {
      log.cliWarn(`⚠️  ${provider}: Model listing endpoint not found`);
    }
  } else if (errorMessage.includes("HTTP 401") || errorMessage.includes("Unauthorized")) {
    log.cliError(`❌ ${provider}: Invalid API key - please check your configuration`);
  } else if (errorMessage.includes("HTTP 403") || errorMessage.includes("Forbidden")) {
    log.cliError(`❌ ${provider}: Access denied - please check your API key permissions`);
  } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("network")) {
    log.cliError(`❌ ${provider}: Network error - please check your internet connection`);
  } else if (errorMessage.includes("timeout")) {
    log.cliError(`❌ ${provider}: Request timeout - please try again later`);
  } else {
    log.cliError(`❌ ${provider}: ${errorMessage}`);
  }
}

/**
 * Helper function to get a user-friendly error message from any error
 */
function getErrorMessage(error: any): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error?.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error occurred";
}

/**
 * Register all AI-related shared commands
 */
export function registerAiCommands(): void {
  // Register AI completion command
  sharedCommandRegistry.registerCommand({
    id: "ai.complete",
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

        // Create AI completion service with proper configuration service
        const mockConfigService = {
          loadConfiguration: (workingDir: string) => Promise.resolve({ resolved: config }),
        };
        const completionService = new DefaultAICompletionService(mockConfigService);

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

  // Register AI fast-apply command
  sharedCommandRegistry.registerCommand({
    id: "ai.fast-apply",
    category: CommandCategory.CORE,
    name: "fast-apply",
    description: "Apply fast edits to a file using fast-apply models",
    parameters: aiFastApplyParams,
    execute: async (params, context) => {
      try {
        const { filePath, instructions, provider, model, dryRun } = params;

        // Import filesystem utilities
        const fs = await import("fs/promises");
        const path = await import("path");

        // Read the target file
        let originalContent: string;
        try {
          originalContent = (await fs.readFile(filePath, "utf-8")) as string;
        } catch (error) {
          log.cliError(
            `Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
          );
          exit(1);
        }

        // Get AI configuration
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        // Find fast-apply capable provider if not specified
        let targetProvider = provider;
        if (!targetProvider) {
          // Auto-detect fast-apply provider
          const fastApplyProviders = Object.entries(aiConfig.providers)
            .filter(
              ([name, providerConfig]) =>
                providerConfig?.enabled &&
                // Check if provider supports fast-apply (morph for now)
                name === "morph"
            )
            .map(([name]) => name);

          if (fastApplyProviders.length === 0) {
            log.cliError(
              "No fast-apply capable providers configured. Please configure Morph or another fast-apply provider."
            );
            exit(1);
          }

          targetProvider = fastApplyProviders[0];
          log.info(`Auto-detected fast-apply provider: ${targetProvider}`);
        }

        // Create AI completion service
        const mockConfigService = {
          loadConfiguration: (workingDir: string) => Promise.resolve({ resolved: config }),
        };
        const completionService = new DefaultAICompletionService(mockConfigService);

        // Create fast-apply prompt
        const prompt = `Original file content:
\`\`\`${path.extname(filePath).slice(1) || "text"}
${originalContent}
\`\`\`

Instructions: ${instructions}

Apply the requested changes and return ONLY the complete updated file content. Do not include explanations or markdown formatting.`;

        log.info(`Applying edits to ${filePath} using ${targetProvider}...`);

        // Generate the edited content
        const response = await completionService.complete({
          prompt,
          provider: targetProvider,
          model: model || (targetProvider === "morph" ? "morph-v3-large" : undefined),
          temperature: 0.1, // Low temperature for precise edits
          maxTokens: Math.max(originalContent.length * 2, 4000), // Ensure enough tokens for the response
          systemPrompt:
            "You are a precise code editor. Return only the final updated file content without any explanations or formatting.",
        });

        const editedContent = response.content.trim();

        // Show the changes
        if (dryRun) {
          log.cli("🔍 Dry run - showing proposed changes:");
          log.cli("\n--- Original ---");
          log.cli(originalContent);
          log.cli("\n--- Edited ---");
          log.cli(editedContent);
          log.cli(
            `\nTokens used: ${response.usage.totalTokens} (${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion)`
          );
          if (response.usage.cost) {
            log.cli(`Cost: $${response.usage.cost.toFixed(4)}`);
          }
        } else {
          // Apply the changes
          await fs.writeFile(filePath, editedContent, "utf-8");
          log.cli(`✅ Successfully applied edits to ${filePath}`);
          log.info(
            `Tokens used: ${response.usage.totalTokens} (${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion)`
          );
          if (response.usage.cost) {
            log.info(`Cost: $${response.usage.cost.toFixed(4)}`);
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

        const mockConfigService = {
          loadConfiguration: (workingDir: string) => Promise.resolve({ resolved: config }),
        };
        const completionService = new DefaultAICompletionService(mockConfigService);

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

  // Register AI models available command
  sharedCommandRegistry.registerCommand({
    id: "ai.models.available",
    category: CommandCategory.CORE,
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

        // Get AI configuration directly
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const mockConfigService = {
          loadConfiguration: (workingDir: string) => Promise.resolve({ resolved: config }),
        };
        const completionService = new DefaultAICompletionService(mockConfigService);
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
              "\nTo configure providers, see: https://github.com/edobry/minsky#ai-completion-backend"
            );
          }
          return;
        }

        if (outputFormat === "json") {
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
    category: CommandCategory.CORE,
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

        // Get AI configuration directly
        const config = getConfiguration();
        const aiConfig = config.ai;

        if (!aiConfig?.providers) {
          log.cliError("No AI providers configured. Please configure at least one provider.");
          exit(1);
        }

        const mockConfigService = {
          loadConfiguration: (workingDir: string) => Promise.resolve({ resolved: config }),
        };
        const completionService = new DefaultAICompletionService(mockConfigService);
        const result = await completionService.validateConfiguration();

        // Collect validation results for JSON output
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
          // Test each provider if no specific provider requested
          const providersToTest = provider ? [provider] : Object.keys(aiConfig.providers || {});

          for (const providerName of providersToTest) {
            const providerConfig = aiConfig.providers?.[providerName];
            const providerResult = {
              name: providerName,
              configured: !!providerConfig,
              hasApiKey: !!providerConfig?.apiKey,
              connectionTest: {
                attempted: false,
                successful: false,
                error: undefined as string | undefined,
              },
            };

            if (providerConfig?.apiKey) {
              try {
                providerResult.connectionTest.attempted = true;
                if (!json) log.cli(`Testing ${providerName}...`);

                await completionService.complete({
                  prompt: "Hello",
                  provider: providerName,
                  maxTokens: 5,
                });

                providerResult.connectionTest.successful = true;
                if (!json) log.cli(`✓ ${providerName} connection successful`);
              } catch (error) {
                providerResult.connectionTest.error =
                  error instanceof Error ? error.message : String(error);
                if (!json) {
                  log.cliError(
                    `✗ ${providerName} connection failed: ${providerResult.connectionTest.error}`
                  );
                }
              }
            } else {
              if (!json) log.cliWarn(`⚠ ${providerName} not configured (missing API key)`);
            }

            validationResults.providers.push(providerResult);
          }
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
    id: "ai.models.refresh",
    category: CommandCategory.CORE,
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

          if (!providerConfig.apiKey) {
            log.cliError(
              `Provider '${provider}' is missing an API key. Please configure the API key first.`
            );
            exit(1);
          }

          if (!force && !(await cacheService.isCacheStale(provider))) {
            log.info(
              `Cache for provider '${provider}' is still fresh. Use --force to refresh anyway.`
            );
            return;
          }

          log.info(`Refreshing models for provider: ${provider}`);
          try {
            await cacheService.refreshProvider(provider, {
              apiKey: providerConfig.apiKey!,
              baseURL: providerConfig.baseURL,
            });
            log.cli(`✓ Successfully refreshed models for ${provider}`);
          } catch (refreshError) {
            handleRefreshError(provider, refreshError);
          }
        } else {
          // Refresh all providers
          const providerConfigs: Record<string, any> = {};
          const configuredProviders = Object.keys(aiConfig.providers || {});
          const errors: string[] = [];

          for (const providerName of configuredProviders) {
            const providerConfig = await configService.getProviderConfig(providerName);
            if (providerConfig && providerConfig.apiKey) {
              if (force || (await cacheService.isCacheStale(providerName))) {
                providerConfigs[providerName] = {
                  apiKey: providerConfig.apiKey,
                  baseURL: providerConfig.baseURL,
                };
              }
            } else if (!providerConfig?.apiKey) {
              log.cliWarn(`Skipping ${providerName}: No API key configured`);
            }
          }

          if (Object.keys(providerConfigs).length === 0) {
            log.info("All provider caches are fresh. Use --force to refresh anyway.");
            return;
          }

          log.info(`Refreshing models for ${Object.keys(providerConfigs).length} providers...`);

          // Refresh providers individually to handle errors gracefully
          let successCount = 0;
          for (const [providerName, config] of Object.entries(providerConfigs)) {
            try {
              await cacheService.refreshProvider(providerName, config);
              log.cli(`✓ Successfully refreshed models for ${providerName}`);
              successCount++;
            } catch (refreshError) {
              handleRefreshError(providerName, refreshError);
              errors.push(providerName);
            }
          }

          if (successCount > 0) {
            log.cli(`\n✓ Successfully refreshed ${successCount} provider(s)`);
          }

          if (errors.length > 0) {
            log.cliWarn(`Failed to refresh ${errors.length} provider(s): ${errors.join(", ")}`);
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
    category: CommandCategory.CORE,
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

        const cacheService = createModelCacheService();
        const allModels = await cacheService.getAllCachedModels();

        let modelsToShow = allModels;
        if (provider) {
          modelsToShow = { [provider]: allModels[provider] || [] };
        }

        if (outputFormat === "json") {
          log.cli(JSON.stringify(modelsToShow, null, 2));
        } else if (outputFormat === "yaml") {
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
    id: "ai.providers.list",
    category: CommandCategory.CORE,
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

        const providers: Array<{
          name: string;
          configured: boolean;
          hasApiKey: boolean;
          lastFetched: string | undefined;
          modelCount: number;
          lastSuccess: boolean | null;
          isStale: boolean;
          error: string | undefined;
        }> = [];
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

        if (outputFormat === "json") {
          log.cli(JSON.stringify(providers, null, 2));
        } else {
          // Table format
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
    id: "ai.cache.clear",
    category: CommandCategory.CORE,
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

        const cacheService = createModelCacheService();

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
          `Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    },
  });
}
