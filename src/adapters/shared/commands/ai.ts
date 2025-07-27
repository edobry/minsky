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
    name: "AI Complete",
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
    name: "AI Chat",
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
    name: "AI Models",
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
}
