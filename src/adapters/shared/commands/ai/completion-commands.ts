/**
 * AI Completion Commands
 *
 * Registers ai.complete, ai.chat, and ai.fast-apply commands.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
} from "../../command-registry";
import { log } from "../../../../utils/logger";
import { exit } from "../../../../utils/process";
import { executeFastApply } from "../../../../domain/ai/fast-apply-service";
import { createCompletionService } from "../../../../domain/ai/service-factory";
import { requireAIProviders } from "../../../../domain/ai/provider-operations";
import { getResolvedConfig } from "./shared";

/**
 * Parameters for AI completion command
 */
const aiCompleteParams = {
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
} satisfies CommandParameterMap;

/**
 * Parameters for fast-apply command
 */
const aiFastApplyParams = {
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
} satisfies CommandParameterMap;

/**
 * Register AI completion, chat, and fast-apply commands
 */
export function registerCompletionCommands(): void {
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
}
