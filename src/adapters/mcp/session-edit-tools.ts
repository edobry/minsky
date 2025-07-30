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
    description: "Edit a file within a session workspace using a diff-like format",
    parameters: FileEditSchema,
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
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          fileExisted: fileExists,
          contentLength: finalContent.length,
        });

        return createSuccessResponse(
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

        return createSuccessResponse(
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
 * Apply edit pattern with "// ... existing code ..." markers
 * Matches Cursor's edit_file behavior
 */
function applyEditPattern(originalContent: string, editContent: string): string {
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
