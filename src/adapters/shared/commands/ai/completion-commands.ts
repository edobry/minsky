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
import { detectSuspiciousCollapse, formatLineCount } from "@minsky/domain/ai/edit-pattern-utils";
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
/** Shape of the collapse detector this module consumes (mt#2577's predicate). */
type CollapseDetector = (
  originalContent: string,
  finalContent: string
) => { originalLines: number; finalLines: number } | null;

/** What the fast-apply handler should DO with a model result (mt#3741). */
export type FastApplyOutcome =
  | { kind: "refuse"; message: string }
  | { kind: "preview" }
  | { kind: "write" };

/**
 * Decide whether a fast-apply result may be persisted (mt#3741).
 *
 * `ai fast-apply` was the last surface in the repo that wrote apply-model output to disk with
 * no post-condition check. It is reachable by agents, not just operators: ADR-011 auto-bridges
 * the `AI` command category to MCP, so `ai_fast-apply` is a live MCP tool.
 *
 * The DECISION is not defined here — `detectSuspiciousCollapse` lives in
 * `@minsky/domain/ai/edit-pattern-utils`, shared with `session_edit_file` (mt#2577) and
 * `tasks_spec_patch` (mt#3674). This function owns only the file-surface refusal message and
 * the ORDERING, expressed as data so a reorder past the write fails a test rather than
 * shipping silently (the mt#3674 lesson applied one surface over).
 *
 * Precedence: `refuse` outranks `dryRun` — a preview that renders a collapsed body as an
 * ordinary diff reads as a large-but-intended edit, which is exactly the misread to avoid.
 */
export function decideFastApplyOutcome(args: {
  filePath: string;
  originalContent: string;
  editedContent: string;
  allowShrink: boolean;
  dryRun: boolean;
  detect: CollapseDetector;
}): FastApplyOutcome {
  if (!args.allowShrink) {
    const collapse = args.detect(args.originalContent, args.editedContent);
    if (collapse) {
      const dropPct = Math.round((1 - collapse.finalLines / collapse.originalLines) * 100);
      return {
        kind: "refuse",
        message:
          `Refusing to apply fast-apply result to "${args.filePath}": the edited content is ` +
          `dramatically smaller than the original (${formatLineCount(collapse.originalLines)} -> ` +
          `${formatLineCount(collapse.finalLines)}, a ${dropPct}% drop). This is the apply-model collapse ` +
          `failure (mt#2577/mt#3674/mt#3741) — the model likely mis-resolved a ` +
          `'// ... existing code ...' marker and dropped content it should have preserved. ` +
          `Re-issue with a tighter, smaller edit, or pass allowShrink=true if this large ` +
          `deletion is intentional.`,
      };
    }
  }
  return args.dryRun ? { kind: "preview" } : { kind: "write" };
}

/**
 * Execute a {@link FastApplyOutcome} (PR #2650 R1).
 *
 * Split out from the handler so the ACT half is testable against a real file: the reviewer
 * correctly noted that asserting the decision does not by itself demonstrate the file on disk
 * survives a refusal. The write is injected so a test can use the real `fs.writeFile` against a
 * temp file, and the handler passes its own dynamically-imported one.
 *
 * Throws on `refuse` — the shared-command layer maps a thrown error to a non-zero CLI exit, so
 * the exit-code half of the criterion belongs to that framework rather than to this function.
 */
export async function applyFastApplyOutcome(args: {
  outcome: FastApplyOutcome;
  filePath: string;
  editedContent: string;
  writeFile: (path: string, content: string, encoding: "utf-8") => Promise<void>;
}): Promise<void> {
  if (args.outcome.kind === "refuse") {
    throw new Error(args.outcome.message);
  }
  if (args.outcome.kind === "write") {
    await args.writeFile(args.filePath, args.editedContent, "utf-8");
  }
}

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
  allowShrink: {
    schema: z.boolean(),
    description:
      "Override the collapse guard, which refuses a fast-apply result dramatically smaller " +
      "than the original file. Set true only when the large deletion is intentional.",
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
      const { filePath, instructions, codeEdit, provider, model, dryRun, allowShrink } = params;

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

      // mt#3741 collapse guard — the third apply-model surface. `executeFastApply` returns a
      // MODEL's output, and this was the last place in the repo that persisted such output
      // with no post-condition. Same predicate as `session_edit_file` (mt#2577) and
      // `tasks_spec_patch` (mt#3674), imported rather than re-derived: one heuristic, three
      // surfaces. Ordering is decided as DATA so "refuse outranks dryRun, and nothing is
      // written on a refusal" is asserted by tests rather than by statement order.
      const outcome = decideFastApplyOutcome({
        filePath,
        originalContent,
        editedContent: result.editedContent,
        allowShrink: !!allowShrink,
        dryRun: !!dryRun,
        detect: detectSuspiciousCollapse,
      });
      await applyFastApplyOutcome({
        outcome,
        filePath,
        editedContent: result.editedContent,
        writeFile: fs.writeFile,
      });

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
