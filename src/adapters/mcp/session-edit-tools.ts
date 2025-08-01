/**
 * MCP adapter for session-aware file editing operations
 * Provides session-scoped edit_file and search_replace tools that match Cursor's interface
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { readFile, writeFile, stat } from "fs/promises";
import { dirname } from "path";
import { SessionPathResolver } from "./session-files";
import { log } from "../../utils/logger";
import { mkdir } from "fs/promises";
import { Buffer } from "buffer";
import { getErrorMessage } from "../../errors/index";
import { FileEditSchema } from "../../domain/schemas";
import { createSuccessResponse, createErrorResponse } from "../../domain/schemas";

// Import schemas that haven't been migrated yet
import {
  SessionSearchReplaceSchema,
  SessionFileEditSchema,
  type SessionSearchReplace,
  type SessionFileEdit,
} from "./schemas/common-parameters";

/**
 * Interface for edit file operation - now using shared type
 */
type EditFileArgs = SessionFileEdit;

/**
 * Interface for search replace operation - now using shared type
 */
type SearchReplaceArgs = SessionSearchReplace;

/**
 * Registers session-aware file editing tools with the MCP command mapper
 */
export function registerSessionEditTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

  // Session edit file tool
  commandMapper.addCommand({
    name: "session.edit_file",
    description: `Use this tool to make an edit to an existing file. This will be read by a less intelligent model, which will quickly apply the edit. You should make it clear what the edit is, while also minimizing the unchanged code you write.

When writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines.

For example:

// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...
THIRD_EDIT
// ... existing code ...

You should still bias towards repeating as few lines of the original file as possible to convey the change. But, each edit should contain sufficient context of unchanged lines around the code you're editing to resolve ambiguity.
DO NOT omit spans of pre-existing code (or comments) without using the // ... existing code ... comment to indicate its absence. If you omit the existing code comment, the model may inadvertently delete these lines.
If you plan on deleting a section, you must provide context before and after to delete it. If the initial code is \`code
Block 1
Block 2
Block 3
code\`, and you want to remove Block 2, you would output \`// ... existing code ...
Block 1
Block 3
// ... existing code ...\`.
Make sure it is clear what the edit should be, and where it should be applied.
Make edits to a file in a single edit_file call instead of multiple edit_file calls to the same file. The apply model can handle many distinct edits at once.`,
    parameters: SessionFileEditSchema,
    handler: async (args: EditFileArgs): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        // Check if file exists
        let fileExists = false;
        let originalContent = "";

        try {
          await stat(resolvedPath);
          fileExists = true;
          originalContent = (await readFile(resolvedPath, "utf8")).toString();
        } catch (error) {
          // File doesn't exist - that's ok for new files
          fileExists = false;
        }

        // If file doesn't exist and we have existing code markers, that's an error
        if (!fileExists && args.content.includes("// ... existing code ...")) {
          throw new Error(
            `Cannot apply edits with existing code markers to non-existent file: ${args.path}`
          );
        }

        let finalContent: string;

        if (fileExists && args.content.includes("// ... existing code ...")) {
          // Apply the edit pattern using fast-apply providers
          finalContent = await applyEditPattern(originalContent, args.content);
        } else {
          // Direct write for new files or complete replacements
          finalContent = args.content;
        }

        // Create parent directories if needed
        if (args.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        // Write the file
        await writeFile(resolvedPath, finalContent, "utf8");

        log.debug("Session file edit successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          fileExisted: fileExists,
          contentLength: finalContent.length,
        });

        return createSuccessResponse({
          path: args.path,
          session: args.sessionName,
          edited: true,
          created: !fileExists,
          bytesWritten: Buffer.from(finalContent, "utf8").byteLength,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file edit failed", {
          session: args.sessionName,
          path: args.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, {
          path: args.path,
          session: args.sessionName,
        });
      }
    },
  });

  // Session search replace tool
  commandMapper.addCommand({
    name: "session.search_replace",
    description: "Replace a single occurrence of text in a file within a session workspace",
    parameters: SessionSearchReplaceSchema,
    handler: async (args: SearchReplaceArgs): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        // Validate file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Read file content
        const content = (await readFile(resolvedPath, "utf8")).toString();

        // Count occurrences
        const occurrences = countOccurrences(content, args.search);

        if (occurrences === 0) {
          throw new Error(`Search text not found in file: "${args.search}"`);
        }

        if (occurrences > 1) {
          throw new Error(
            `Search text found ${occurrences} times. Please provide more context to make it unique.`
          );
        }

        // Perform replacement
        const newContent = content.replace(args.search, args.replace);

        // Write back
        await writeFile(resolvedPath, newContent, "utf8");

        log.debug("Session search replace successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          searchLength: args.search.length,
          replaceLength: args.replace.length,
        });

        return createSuccessResponse({
          path: args.path,
          session: args.sessionName,
          edited: true,
          replaced: true,
          searchText: args.search,
          replaceText: args.replace,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session search replace failed", {
          session: args.sessionName,
          path: args.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, {
          path: args.path,
          session: args.sessionName,
        });
      }
    },
  });

  log.debug("Session edit tools registered successfully");
}

/**
 * Apply edit pattern using fast-apply providers with fallback support
 * Uses AI-powered editing to replace legacy string-based pattern matching
 */
async function applyEditPattern(originalContent: string, editContent: string): Promise<string> {
  // Import required dependencies
  const { DefaultAICompletionService } = await import("../../domain/ai/completion-service");
  const { getConfiguration } = await import("../../domain/configuration");

  // Get AI configuration
  const config = getConfiguration();
  const aiConfig = config.ai;

  if (!aiConfig?.providers) {
    throw new Error("No AI providers configured for edit operations");
  }

  // Find fast-apply capable provider (currently Morph, extendable to others)
  const fastApplyProviders = Object.entries(aiConfig.providers)
    .filter(
      ([name, providerConfig]) => providerConfig?.enabled && name === "morph" // Add other fast-apply providers here as needed
    )
    .map(([name]) => name);

  let provider: string;
  let model: string | undefined;
  let isFastApply = false;

  if (fastApplyProviders.length > 0) {
    // Use fast-apply provider
    provider = fastApplyProviders[0];
    model = provider === "morph" ? "morph-v3-large" : undefined;
    isFastApply = true;
    log.debug(`Using fast-apply provider: ${provider}`);
  } else {
    // Fallback to default provider
    provider = aiConfig.defaultProvider || "anthropic";

    // Simple fallback - try to find an enabled provider with API key
    const fallbackConfig = aiConfig.providers[provider];
    if (!fallbackConfig?.enabled || !fallbackConfig?.apiKey) {
      // Try Anthropic as ultimate fallback
      provider = "anthropic";
    }

    log.debug(`Fast-apply providers unavailable, using fallback provider: ${provider}`);
  }

  // Create AI completion service
  const completionService = new DefaultAICompletionService({
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  } as any);

  // Create edit prompt optimized for the provider type
  const prompt = `Apply the following edit pattern to the original content:

Original content:
\`\`\`
${originalContent}
\`\`\`

Edit pattern:
\`\`\`
${editContent}
\`\`\`

Instructions:
- Apply the edits shown in the edit pattern to the original content
- The edit pattern uses "// ... existing code ..." markers to indicate unchanged sections
- Return ONLY the complete updated file content
- Preserve all formatting, indentation, and structure
- Do not include explanations or markdown formatting`;

  // Generate the edited content using the selected provider
  const response = await completionService.complete({
    prompt,
    provider,
    model,
    temperature: 0.1, // Low temperature for precise edits
    maxTokens: Math.max(originalContent.length * 2, 4000),
    systemPrompt:
      "You are a precise code editor. Apply the edit pattern exactly as specified and return only the final updated content.",
  });

  const result = response.content.trim();

  // Log usage for monitoring
  log.debug(
    `Edit completed using ${isFastApply ? "fast-apply" : "fallback"} provider: ${provider}`,
    {
      tokensUsed: response.usage.totalTokens,
      originalLength: originalContent.length,
      resultLength: result.length,
      isFastApply,
    }
  );

  return result;
}

/**
 * Count occurrences of a string in content
 */
function countOccurrences(content: string, search: string): number {
  let count = 0;
  let position = 0;

  while ((position = content.toString().indexOf(search, position)) !== -1) {
    count++;
    position += search.length;
  }

  return count;
}
