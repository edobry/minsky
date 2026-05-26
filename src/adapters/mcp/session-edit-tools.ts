/**
 * MCP adapter for session-aware file editing operations
 * Provides session-scoped edit_file and search_replace tools that match Cursor's interface
 *
 * mt#1792: heavy handler-module imports deferred into getHandler thunks.
 * Top-level imports are limited to lightweight metadata/schema dependencies
 * (CommandMapper type, schema types, logger, error utilities). The runtime
 * dependencies (fs/promises, applyEditPattern, diff utils, Buffer) load on
 * first tool call and are cached by the JS module system thereafter.
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";

// Import schemas that haven't been migrated yet — needed at registration time
// for tools/list metadata. These are lightweight schema-only imports.
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
export function registerSessionEditTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  // Session edit file tool — lazy handler (mt#1792)
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
    getHandler: async () => {
      // mt#1792: defer heavy runtime imports until first call.
      // These modules are loaded once and cached by the JS module system.
      const [
        { writeFile, stat, mkdir },
        { readTextFile },
        { dirname },
        { SessionPathResolver },
        { Buffer },
        { createSuccessResponse, createErrorResponse },
        { applyEditPattern },
        { generateUnifiedDiff, generateDiffSummary },
      ] = await Promise.all([
        import("fs/promises"),
        import("@minsky/shared/fs"),
        import("path"),
        import("@minsky/domain/session/session-path-resolver"),
        import("buffer"),
        import("@minsky/domain/schemas"),
        import("@minsky/domain/ai/edit-pattern-service"),
        import("../../utils/diff"),
      ]);

      // Lazy DI: defer sessionProvider lookup until dispatch time. Tool
      // registration runs before container.initialize() so a direct lookup here
      // would observe container.has("sessionProvider") === false (mt#1799).
      const pathResolver = new SessionPathResolver(() =>
        container?.has("sessionProvider") ? container.get("sessionProvider") : undefined
      );

      return async (rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
          } catch (_error) {
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
      };
    },
  });

  // Session search replace tool — lazy handler (mt#1792)
  commandMapper.addCommand({
    name: "session.search_replace",
    description:
      "Replace text in a file within a session workspace. By default, requires exactly one occurrence (for safety). Set replace_all=true to replace all occurrences.",
    parameters: SessionSearchReplaceSchema,
    getHandler: async () => {
      // mt#1792: defer heavy runtime imports until first call.
      const [
        { writeFile },
        { readTextFile },
        { SessionPathResolver },
        { createSuccessResponse, createErrorResponse },
      ] = await Promise.all([
        import("fs/promises"),
        import("@minsky/shared/fs"),
        import("@minsky/domain/session/session-path-resolver"),
        import("@minsky/domain/schemas"),
      ]);

      const pathResolver = new SessionPathResolver(() =>
        container?.has("sessionProvider") ? container.get("sessionProvider") : undefined
      );

      return async (rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const args = rawArgs as SearchReplaceArgs;
        try {
          // Resolve parameter aliases: old_string/new_string (Claude Code Edit tool convention)
          // take precedence when provided, falling back to search/replace
          const searchText = args.search ?? args.old_string;
          const replaceText = args.replace ?? args.new_string;

          // Validate required parameters to catch parameter naming mismatches early
          if (searchText == null || typeof searchText !== "string") {
            const receivedKeys = Object.keys(args).join(", ");
            throw new Error(
              `Missing required parameter "search" (or alias "old_string"). Received parameters: [${receivedKeys}]. ` +
                `Expected: sessionId, path, search, replace (or old_string, new_string)`
            );
          }
          if (replaceText == null || typeof replaceText !== "string") {
            const receivedKeys = Object.keys(args).join(", ");
            throw new Error(
              `Missing required parameter "replace" (or alias "new_string"). Received parameters: [${receivedKeys}]. ` +
                `Expected: sessionId, path, search, replace (or old_string, new_string)`
            );
          }

          const resolvedPath = await pathResolver.resolvePath(args.sessionId, args.path);

          // Validate file exists
          await pathResolver.validatePathExists(resolvedPath);

          // Read file content
          const content = await readTextFile(resolvedPath);

          // Count occurrences
          const occurrences = countOccurrences(content, searchText);

          if (occurrences === 0) {
            throw new Error(`Search text not found in file: "${searchText}"`);
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
            newContent = content.replaceAll(searchText, () => replaceText);
            replacementCount = occurrences;
          } else {
            newContent = content.replace(searchText, () => replaceText);
            replacementCount = 1;
          }

          // Write back
          await writeFile(resolvedPath, newContent, "utf8");

          log.debug("Session search replace successful", {
            session: args.sessionId,
            path: args.path,
            resolvedPath,
            searchLength: searchText.length,
            replaceLength: replaceText.length,
            replacementCount,
            replaceAll,
          });

          return createSuccessResponse({
            path: args.path,
            session: args.sessionId,
            edited: true,
            replaced: true,
            replacementCount,
            searchText,
            replaceText,
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
      };
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
