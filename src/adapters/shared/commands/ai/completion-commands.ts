/**
 * AI Completion Commands
 *
 * Registers the ai.complete, ai.fast-apply, and ai.chat shared commands.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
} from "../../command-registry";
import { createCompletionService } from "@minsky/domain/ai/service-factory";
import { executeFastApply } from "@minsky/domain/ai/fast-apply-service";
import { requireAIProviders } from "@minsky/domain/ai/provider-operations";
import { getResolvedConfig, withTimeout, DEFAULT_AI_COMPLETE_TIMEOUT_MS } from "./shared-helpers";
import { buildCompleteResult } from "./result-builders";

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
  timeoutMs: {
    schema: z.number().min(1000),
    description:
      `Timeout in milliseconds for the provider call (default ${DEFAULT_AI_COMPLETE_TIMEOUT_MS}). ` +
      "The call fails fast with an actionable error instead of hanging when exceeded.",
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
 * Register AI completion-related shared commands (complete, fast-apply, chat)
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
      // mt#2727: return structured data ({content, usage, model, provider})
      // instead of writing the completion directly to Bun.stdout. The old
      // unconditional Bun.stdout write corrupted the MCP server's stdio
      // JSON-RPC transport framing, which — combined with never returning a
      // valid MCP response — caused every MCP caller to hang to the full
      // client-side idle timeout. The bounded timeout below is the second
      // half of the fix: fail fast with an actionable error instead of
      // hanging indefinitely on a wedged provider call.
      const { prompt, model, provider, temperature, maxTokens, stream, system, timeoutMs } = params;

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

      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_AI_COMPLETE_TIMEOUT_MS;
      const timeoutMessage =
        `AI completion timed out after ${effectiveTimeoutMs}ms ` +
        `(provider=${provider ?? "default"}, model=${model ?? "default"}). ` +
        "The provider call did not return in time. Check network connectivity and " +
        "provider/API-key status (ai.validate), or pass a larger timeoutMs.";

      if (request.stream) {
        // Live-typing to the terminal is CLI-only UX. Gating the Bun.stdout
        // write on context.interface === "cli" (rather than writing
        // unconditionally, as the old code did) is what removes the direct
        // write from the MCP-exposed path — MCP callers get the assembled
        // `content` in the structured return value instead.
        const consumeStream = async (): Promise<{ content: string }> => {
          let content = "";
          for await (const chunk of completionService.stream(request)) {
            content += chunk.content;
            if (context.interface === "cli") {
              await Bun.write(Bun.stdout, chunk.content);
            }
          }
          if (context.interface === "cli") {
            await Bun.write(Bun.stdout, "\n");
          }
          return { content };
        };

        const { content } = await withTimeout(consumeStream(), effectiveTimeoutMs, timeoutMessage);

        return buildCompleteResult({
          content,
          model: model ?? null,
          provider: provider ?? null,
          streamed: true,
        });
      }

      const response = await withTimeout(
        completionService.complete(request),
        effectiveTimeoutMs,
        timeoutMessage
      );

      return buildCompleteResult({
        content: response.content,
        model: response.model ?? model ?? null,
        provider: response.provider ?? provider ?? null,
        usage: response.usage ?? null,
        streamed: false,
      });
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
    execute: async (params, _context) => {
      // mt#2727: return structured data; CLI diff/summary rendering lives in
      // src/adapters/cli/customizations/ai-customizations.ts.
      const { filePath, instructions, codeEdit, provider, model, dryRun } = params;

      if (!instructions && !codeEdit) {
        throw new Error("Either 'instructions' or 'codeEdit' parameter must be provided");
      }

      const fs = await import("fs/promises");

      let originalContent: string;
      try {
        originalContent = (await fs.readFile(filePath, "utf-8")) as string;
      } catch (error) {
        throw new Error(
          `Failed to read file ${filePath}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }

      const config = getResolvedConfig();
      requireAIProviders(config);

      const result = await executeFastApply(config, {
        filePath,
        originalContent,
        instructions,
        codeEdit,
        provider,
        model,
      });

      if (!dryRun) {
        await fs.writeFile(filePath, result.editedContent, "utf-8");
      }

      return {
        success: true,
        filePath,
        dryRun: !!dryRun,
        mode: result.mode,
        provider: result.provider,
        editedContent: result.editedContent,
        originalContent: dryRun ? originalContent : undefined,
        usage: result.response.usage,
      };
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
    execute: async (_params, _context) => {
      // mt#2727: throw instead of exit(1) — the old exit(1) called
      // process.exit() directly, which would kill the entire MCP server
      // process (not just fail this one tool call) on any MCP caller of
      // ai.chat. Throwing is the MCP-safe error-signaling convention;
      // CLI errors surface the same way via handleCliError.
      const config = getResolvedConfig();
      requireAIProviders(config);

      throw new Error("Interactive chat is not yet implemented. Use 'ai.complete' instead.");
    },
  });
}
