/**
 * MCP adapter for session-aware file editing operations
 * Provides session-scoped edit_file and search_replace tools that match Cursor's interface
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { readFile, writeFile, stat } from "fs/promises";
import { dirname } from "path";
import { SessionPathResolver } from "./session-files.js";
import { log } from "../../utils/logger.js";
import { mkdir } from "fs/promises";
import { Buffer } from "buffer";

/**
 * Interface for edit file operation
 */
interface EditFileArgs {
  session: string;
  path: string;
  instructions: string;
  content: string;
  createDirs?: boolean;
}

/**
 * Interface for search replace operation
 */
interface SearchReplaceArgs {
  session: string;
  path: string;
  search: string;
  replace: string;
}

/**
 * Registers session-aware file editing tools with the MCP command mapper
 */
export function registerSessionEditTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

  // Session edit file tool
  commandMapper.addTool(
    "session_edit_file",
    "Edit a file within a session workspace using a diff-like format",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
      instructions: z.string().describe("Instructions describing the edit to make"),
      content: z.string().describe("The edit content with '// ... existing code ...' markers"),
      createDirs: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
    }),
    async (args: EditFileArgs): Promise<Record<string, unknown>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);

        // Check if file exists
        let fileExists = false;
        let originalContent = "";

        try {
          await stat(resolvedPath);
          fileExists = true;
          originalContent = (await readFile(resolvedPath, "utf8")) as string;
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
          // Apply the edit pattern
          finalContent = applyEditPattern(originalContent, args.content);
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
          session: args.session,
          path: args.path,
          resolvedPath,
          fileExisted: fileExists,
          contentLength: finalContent.length,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          edited: true,
          created: !fileExists,
          bytesWritten: Buffer.from(finalContent, "utf8").byteLength,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session file edit failed", {
          session: args.session,
          path: args.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: args.path,
          session: args.session,
        };
      }
    }
  );

  // Session search replace tool
  commandMapper.addTool(
    "session_search_replace",
    "Replace a single occurrence of text in a file within a session workspace",
    z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
      search: z.string().describe("Text to search for (must be unique in the file)"),
      replace: z.string().describe("Text to replace with"),
    }),
    async (args: SearchReplaceArgs): Promise<Record<string, unknown>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);

        // Validate file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Read file content
        const content = (await readFile(resolvedPath, "utf8")) as string;

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
          session: args.session,
          path: args.path,
          resolvedPath,
          searchLength: args.search.length,
          replaceLength: args.replace.length,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          replaced: true,
          searchText: args.search,
          replaceText: args.replace,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Session search replace failed", {
          session: args.session,
          path: args.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: args.path,
          session: args.session,
        };
      }
    }
  );

  log.debug("Session edit tools registered successfully");
}

/**
 * Apply edit pattern with "// ... existing code ..." markers
 * This is a simplified implementation - will be enhanced based on testing
 */
function applyEditPattern(originalContent: string, editContent: string): string {
  // TODO: Implement sophisticated pattern matching for:
  // 1. Multiple edit blocks
  // 2. Context matching before/after existing code markers
  // 3. Indentation preservation
  // 4. Language-specific comment markers

  // For now, a basic implementation
  if (!editContent.includes("// ... existing code ...")) {
    return editContent;
  }

  // This will be expanded in the next iteration
  return originalContent;
}

/**
 * Count occurrences of a string in content
 */
function countOccurrences(content: string, search: string): number {
  let count = 0;
  let position = 0;

  while ((position = content.indexOf(search, position)) !== -1) {
    count++;
    position += search.length;
  }

  return count;
}
