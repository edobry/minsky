/**
 * MCP adapter for session-aware file editing operations
 * Provides session-scoped edit_file and search_replace tools that match Cursor's interface
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { writeFile, stat } from "fs/promises";
import { readTextFile } from "../../utils/fs";
import { dirname } from "path";
import { SessionPathResolver } from "../../domain/session/session-path-resolver";
import { log } from "../../utils/logger";
import { mkdir } from "fs/promises";
import { Buffer } from "buffer";
import { getErrorMessage } from "../../errors/index";
import { FileEditSchema } from "../../domain/schemas";
import { createSuccessResponse, createErrorResponse } from "../../domain/schemas";
import { applyEditPattern } from "../../domain/ai/edit-pattern-service";
import { generateUnifiedDiff, generateDiffSummary } from "../../utils/diff";

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
    handler: async (rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const args = rawArgs as EditFileArgs;
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionId, args.path);

        // Check if file exists
        let fileExists = false;
        let originalContent = "";

        try {
          await stat(resolvedPath);
          fileExists = true;
          originalContent = await readTextFile(resolvedPath);
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
          // Apply the edit pattern using fast-apply providers, passing optional instruction
          finalContent = await applyEditPattern(originalContent, args.content, args.instructions);
        } else {
          // Direct write for new files or complete replacements
          finalContent = args.content;
        }

        // Handle dry-run mode
        if (args.dryRun) {
          // Generate diff for dry-run mode
          const diff = generateUnifiedDiff(originalContent, finalContent, args.path);
          const diffSummary = generateDiffSummary(originalContent, finalContent);

          log.debug("Session file edit dry-run completed", {
            session: args.sessionId,
            path: args.path,
            resolvedPath,
            fileExisted: fileExists,
            proposedContentLength: finalContent.length,
            diffSummary,
          });

          return createSuccessResponse({
            timestamp: new Date().toISOString(),
            path: args.path,
            session: args.sessionId,
            resolvedPath,
            dryRun: true,
            proposedContent: finalContent,
            diff,
            diffSummary,
            edited: fileExists,
            created: !fileExists,
          });
        }

        // Create parent directories if needed
        if (args.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        // Write the file
        await writeFile(resolvedPath, finalContent, "utf8");

        log.debug("Session file edit successful", {
          session: args.sessionId,
          path: args.path,
          resolvedPath,
          fileExisted: fileExists,
          contentLength: finalContent.length,
        });

        return createSuccessResponse({
          path: args.path,
          session: args.sessionId,
          edited: true,
          created: !fileExists,
          bytesWritten: Buffer.from(finalContent, "utf8").byteLength,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file edit failed", {
          session: args.sessionId,
          path: args.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: args.path,
          session: args.sessionId,
        });
      }
    },
  });

  // Session search replace tool
  commandMapper.addCommand({
    name: "session.search_replace",
    description:
      "Replace text in a file within a session workspace. By default, requires exactly one occurrence (for safety). Set replace_all=true to replace all occurrences.",
    parameters: SessionSearchReplaceSchema,
    handler: async (rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const args = rawArgs as SearchReplaceArgs;
      try {
        // Validate required parameters to catch parameter naming mismatches early
        if (args.search == null || typeof args.search !== "string") {
          const receivedKeys = Object.keys(args).join(", ");
          throw new Error(
            `Missing required parameter "search". Received parameters: [${receivedKeys}]. ` +
              `Expected: sessionId, path, search, replace`
          );
        }
        if (args.replace == null || typeof args.replace !== "string") {
          const receivedKeys = Object.keys(args).join(", ");
          throw new Error(
            `Missing required parameter "replace". Received parameters: [${receivedKeys}]. ` +
              `Expected: sessionId, path, search, replace`
          );
        }

        const resolvedPath = await pathResolver.resolvePath(args.sessionId, args.path);

        // Validate file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Read file content
        const content = await readTextFile(resolvedPath);

        // Count occurrences
        const occurrences = countOccurrences(content, args.search);

        if (occurrences === 0) {
          throw new Error(`Search text not found in file: "${args.search}"`);
        }

        const replaceAll = args.replace_all ?? false;

        if (!replaceAll && occurrences > 1) {
          throw new Error(
            `Search text found ${occurrences} times. Please provide more context to make it unique, or set replace_all=true to replace all occurrences.`
          );
        }

        // Perform replacement
        let newContent: string;
        let replacementCount: number;

        if (replaceAll) {
          newContent = content.replaceAll(args.search, args.replace);
          replacementCount = occurrences;
        } else {
          newContent = content.replace(args.search, args.replace);
          replacementCount = 1;
        }

        // Write back
        await writeFile(resolvedPath, newContent, "utf8");

        log.debug("Session search replace successful", {
          session: args.sessionId,
          path: args.path,
          resolvedPath,
          searchLength: args.search.length,
          replaceLength: args.replace.length,
          replacementCount,
          replaceAll,
        });

        return createSuccessResponse({
          path: args.path,
          session: args.sessionId,
          edited: true,
          replaced: true,
          replacementCount,
          searchText: args.search,
          replaceText: args.replace,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session search replace failed", {
          session: args.sessionId,
          path: args.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: args.path,
          session: args.sessionId,
        });
      }
    },
  });

  log.debug("Session edit tools registered successfully");
}

/**
 * Count occurrences of a string in content
 */
export function countOccurrences(content: string, search: string): number {
  let count = 0;
  let position = 0;

  while ((position = content.toString().indexOf(search, position)) !== -1) {
    count++;
    position += search.length;
  }

  return count;
}
