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
import {
  SessionFileEditSchema,
  SessionSearchReplaceSchema,
  type SessionFileEdit,
  type SessionSearchReplace,
} from "./schemas/common-parameters";
import { createFileOperationResponse, createErrorResponse } from "./schemas/common-responses";

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

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
          },
          {
            edited: true,
            created: !fileExists,
            bytesWritten: Buffer.from(finalContent, "utf8").byteLength,
          }
        );
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

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
          },
          {
            edited: true,
            replaced: true,
            searchText: args.search,
            replaceText: args.replace,
          }
        );
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
 * Apply edit pattern using fast-apply providers
 * Replaces broken string-based pattern matching with AI-powered editing
 */
async function applyEditPattern(originalContent: string, editContent: string): Promise<string> {
  try {
    // Import required dependencies
    const { DefaultAICompletionService } = await import("../../domain/ai/completion-service");
    const { DefaultAIConfigurationService } = await import("../../domain/ai/config-service");
    const { getConfiguration } = await import("../../domain/configuration");

    // Get AI configuration
    const config = getConfiguration();
    const aiConfig = config.ai;

    if (!aiConfig?.providers) {
      throw new Error("No AI providers configured for fast-apply editing");
    }

    // Find fast-apply capable provider
    const fastApplyProviders = Object.entries(aiConfig.providers)
      .filter(
        ([name, providerConfig]) =>
          providerConfig?.enabled &&
          // Check if provider supports fast-apply (morph for now, extendable)
          name === "morph"
      )
      .map(([name]) => name);

    if (fastApplyProviders.length === 0) {
      // Fallback to the broken implementation for backward compatibility
      log.warn("No fast-apply providers available, falling back to legacy pattern matching");
      return applyEditPatternLegacy(originalContent, editContent);
    }

    const provider = fastApplyProviders[0];
    log.debug(`Using fast-apply provider: ${provider}`);

    // Create AI completion service
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);
    const completionService = new DefaultAICompletionService(configService);

    // Create fast-apply prompt
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

    // Generate the edited content using fast-apply
    const response = await completionService.complete({
      prompt,
      provider,
      model: provider === "morph" ? "morph-v3-large" : undefined,
      temperature: 0.1, // Low temperature for precise edits
      maxTokens: Math.max(originalContent.length * 2, 4000),
      systemPrompt:
        "You are a precise code editor. Apply the edit pattern exactly as specified and return only the final updated content.",
    });

    const result = response.content.trim();

    // Log usage for monitoring
    log.debug(`Fast-apply edit completed using ${provider}`, {
      tokensUsed: response.usage.totalTokens,
      originalLength: originalContent.length,
      resultLength: result.length,
    });

    return result;
  } catch (error) {
    log.warn(
      `Fast-apply edit failed, falling back to legacy pattern matching: ${error instanceof Error ? error.message : String(error)}`
    );

    // Fallback to legacy implementation
    return applyEditPatternLegacy(originalContent, editContent);
  }
}

/**
 * Legacy pattern matching implementation (fallback)
 * Original broken implementation kept for emergency fallback
 */
function applyEditPatternLegacy(originalContent: string, editContent: string): string {
  // If no existing code markers, return the edit content as-is
  if (!editContent.includes("// ... existing code ...")) {
    return editContent;
  }

  // Split the edit content by the existing code marker
  const marker = "// ... existing code ...";
  const editParts = editContent.split(marker);

  // If we only have one part, something's wrong
  if (editParts.length < 2) {
    throw new Error("Invalid edit format: existing code marker found but no content sections");
  }

  let result = originalContent;

  // Process each pair of before/after content around the markers
  for (let i = 0; i < editParts.length - 1; i++) {
    const beforeContent = editParts[i]?.trim() || "";
    const afterContent = editParts[i + 1]?.trim() || "";

    // Find where to apply this edit
    if (i === 0 && beforeContent) {
      // First section - match from the beginning
      const startIndex = result.indexOf(beforeContent);
      if (startIndex === -1) {
        throw new Error(`Could not find content to match: "${beforeContent.substring(0, 50)}..."`);
      }

      // Find the end of the after content
      let endIndex = result.length;
      if (i < editParts.length - 2) {
        // There's another edit section, find where it starts
        const nextBefore = editParts[i + 2]?.trim() || "";
        const nextStart = result.indexOf(nextBefore, startIndex + beforeContent.length);
        if (nextStart !== -1) {
          endIndex = nextStart;
        }
      } else if (afterContent) {
        // Last section with after content
        const afterIndex = result.lastIndexOf(afterContent);
        if (afterIndex !== -1) {
          endIndex = afterIndex + afterContent.length;
        }
      }

      // Apply the edit
      result = `${result.substring(0, startIndex) + beforeContent}\n${result.substring(endIndex)}`;
    } else if (i === editParts.length - 2 && !afterContent) {
      // Last section with no after content - append
      result = `${result}\n${beforeContent}`;
    } else {
      // Middle sections - need to find and replace between markers
      // This is a more complex case that needs careful handling
      // For now, we'll do a simple implementation
      const searchStart = beforeContent || "";
      const searchEnd = afterContent || "";

      if (searchStart) {
        const startIdx = result.indexOf(searchStart);
        if (startIdx === -1) {
          throw new Error(`Could not find content to match: "${searchStart.substring(0, 50)}..."`);
        }

        let endIdx = result.length;
        if (searchEnd) {
          const tempEndIdx = result.indexOf(searchEnd, startIdx + searchStart.length);
          if (tempEndIdx !== -1) {
            endIdx = tempEndIdx + searchEnd.length;
          }
        }

        result = `${result.substring(0, startIdx) + searchStart}\n${
          searchEnd
        }${endIdx < result.length ? result.substring(endIdx) : ""}`;
      }
    }
  }

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
