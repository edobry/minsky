/**
 * MCP adapter for session file operations
 * Provides session-scoped file operations that enforce workspace isolation
 */
import { mkdir, stat, rename } from "fs/promises";
import { join, relative, dirname } from "path";
import type { CommandMapper } from "../../mcp/command-mapper";
import { SessionPathResolver } from "../../domain/session/session-path-resolver";
export { SessionPathResolver };
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { ErrorContext } from "../../utils/semantic-error-classifier";
import {
  FileMoveSchema,
  FileRenameSchema,
  FileOperationResponse,
  FileMoveParameters,
  FileRenameParameters,
} from "../../domain/schemas";
import { createSuccessResponse, createErrorResponse } from "../../domain/schemas";

/**
 * Utility function to process file content with line range support
 */
function processFileContentWithLineRange(
  content: string,
  options: {
    startLine?: number;
    endLine?: number;
    shouldReadEntireFile?: boolean;
    filePath: string;
  }
): {
  content: string;
  totalLines: number;
  linesShown: string;
  summary?: string;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // If should read entire file, return everything
  if (options.shouldReadEntireFile) {
    return {
      content,
      totalLines,
      linesShown: `1-${totalLines} (entire file)`,
    };
  }

  // If no line range specified, use default behavior (first 250 lines max)
  if (!options.startLine && !options.endLine) {
    const maxLines = Math.min(250, totalLines);
    const selectedLines = lines.slice(0, maxLines);
    const resultContent = selectedLines.join("\n");

    let summary: string | undefined;
    if (totalLines > maxLines) {
      summary = `Outline of the rest of the file:\n[Lines ${maxLines + 1}-${totalLines} contain additional content...]`;
    }

    return {
      content: resultContent,
      totalLines,
      linesShown: `1-${maxLines}`,
      summary,
    };
  }

  // Handle line range specification
  let startLine = Math.max(1, options.startLine || 1);
  let endLine: number;

  if (options.endLine !== undefined) {
    endLine = Math.min(totalLines, options.endLine);
  } else {
    // Default window size, but clamp to available content
    endLine = Math.min(totalLines, startLine + 249);
  }

  // Check if explicit ranges were provided (before any modifications)
  const isExplicitRange = options.startLine !== undefined || options.endLine !== undefined;

  // Handle edge cases where startLine > endLine after clamping
  if (startLine > endLine) {
    // If start line is beyond available content, clamp to last line
    if (startLine > totalLines) {
      startLine = totalLines;
      endLine = totalLines;
    } else {
      // If end line is before start line due to user error, just use start line
      endLine = startLine;
    }
  }

  // Additional safety check: ensure both are within bounds
  startLine = Math.max(1, Math.min(totalLines, startLine));
  endLine = Math.max(startLine, Math.min(totalLines, endLine));

  // Determine actual lines to use
  let actualStartLine: number;
  let actualEndLine: number;

  if (isExplicitRange) {
    // For explicit ranges, use exact clamped values without any expansion
    actualStartLine = startLine;
    actualEndLine = endLine;
  } else {
    // Only apply context expansion logic if no explicit ranges were provided
    actualStartLine = startLine;
    actualEndLine = endLine;

    // For very small files (≤50 lines), show entire file if range is small
    if (totalLines <= 50 && endLine - startLine + 1 < totalLines) {
      actualStartLine = 1;
      actualEndLine = totalLines;
    } else {
      // Expand small ranges to at least 50 lines for better context (like Cursor does)
      const requestedLines = endLine - startLine + 1;
      if (requestedLines < 50 && totalLines > 50) {
        const expansion = Math.floor((50 - requestedLines) / 2);
        actualStartLine = Math.max(1, startLine - expansion);
        actualEndLine = Math.min(totalLines, endLine + expansion);
      }
    }
  }

  const selectedLines = lines.slice(actualStartLine - 1, actualEndLine);
  const resultContent = selectedLines.join("\n");

  let summary: string | undefined;
  if (actualStartLine > 1 || actualEndLine < totalLines) {
    const before =
      actualStartLine > 1 ? `Lines 1-${actualStartLine - 1}: [Earlier content...]` : "";
    const after =
      actualEndLine < totalLines
        ? `Lines ${actualEndLine + 1}-${totalLines}: [Later content...]`
        : "";
    const parts = [before, after].filter(Boolean);
    if (parts.length > 0) {
      summary = `Outline of the rest of the file:\n${parts.join("\n")}`;
    }
  }

  return {
    content: resultContent,
    totalLines,
    linesShown:
      actualStartLine === actualEndLine
        ? `${actualStartLine}`
        : `${actualStartLine}-${actualEndLine}`,
    summary,
  };
}

/**
 * Create a new session path resolver instance
 */
function createPathResolver(): SessionPathResolver {
  return new SessionPathResolver();
}

/**
 * Registers session file operation tools with the MCP command mapper
 */
export function registerSessionFileTools(commandMapper: CommandMapper): void {
  const pathResolver = createPathResolver();

  // Session read file tool with line range support
  // Session move file tool
  commandMapper.addCommand({
    name: "session.move_file",
    description: "Move a file from one location to another within a session workspace",
    parameters: FileMoveSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      const typedArgs = args as FileMoveParameters;
      try {
        const sourceResolvedPath = await pathResolver.resolvePath(
          typedArgs.sessionId,
          typedArgs.sourcePath
        );
        const targetResolvedPath = await pathResolver.resolvePath(
          typedArgs.sessionId,
          typedArgs.targetPath
        );

        // Validate source file exists
        await pathResolver.validatePathExists(sourceResolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const sourceStats = await stat(sourceResolvedPath);
        if (!sourceStats.isFile()) {
          throw new Error(
            `Source path "${typedArgs.sourcePath}" is not a file - use appropriate directory tools`
          );
        }

        // Check if target already exists and handle overwrite logic
        let targetExists = false;
        try {
          await stat(targetResolvedPath);
          targetExists = true;
        } catch (error) {
          // Target doesn't exist - that's fine
          targetExists = false;
        }

        if (targetExists && !typedArgs.overwrite) {
          throw new Error(
            `Target path "${typedArgs.targetPath}" already exists. Set overwrite: true to replace it.`
          );
        }

        // Create parent directories if requested and they don't exist
        if (typedArgs.createDirs) {
          const parentDir = dirname(targetResolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        // Perform the atomic move operation
        await rename(sourceResolvedPath, targetResolvedPath);

        log.debug("Session file move successful", {
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          sourceResolvedPath,
          targetResolvedPath,
          overwrite: typedArgs.overwrite,
          createdDirs: typedArgs.createDirs,
        });

        const sourceResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          sourceResolvedPath
        );
        const targetResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          targetResolvedPath
        );

        return createSuccessResponse({
          path: typedArgs.targetPath,
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          sourceResolvedPath: sourceResolvedPath_rel,
          targetResolvedPath: targetResolvedPath_rel,
          moved: true,
          overwritten: targetExists,
        });
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "move_file",
          path: `${typedArgs.sourcePath} -> ${typedArgs.targetPath}`,
          session: typedArgs.sessionId,
          createDirs: typedArgs.createDirs,
        };

        log.error("Session file move failed", {
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), undefined, {
          session: typedArgs.sessionId,
          path: typedArgs.sourcePath,
        });
      }
    },
  });

  // Session rename file tool
  commandMapper.addCommand({
    name: "session.rename_file",
    description: "Rename a file within a session workspace",
    parameters: FileRenameSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      const typedArgs = args as FileRenameParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);

        // Validate source file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(
            `Path "${typedArgs.path}" is not a file - use appropriate directory tools`
          );
        }

        // Construct target path by replacing the filename
        const sourceDir = dirname(resolvedPath);
        const targetResolvedPath = join(sourceDir, typedArgs.newName);
        const targetPath = join(dirname(typedArgs.path), typedArgs.newName);

        // Validate that target path is still within session workspace
        await pathResolver.resolvePath(typedArgs.sessionId, targetPath);

        // Check if target already exists and handle overwrite logic
        let targetExists = false;
        try {
          await stat(targetResolvedPath);
          targetExists = true;
        } catch (error) {
          // Target doesn't exist - that's fine
          targetExists = false;
        }

        if (targetExists && !typedArgs.overwrite) {
          throw new Error(
            `Target file "${typedArgs.newName}" already exists in the same directory. Set overwrite: true to replace it.`
          );
        }

        // Perform the atomic rename operation
        await rename(resolvedPath, targetResolvedPath);

        log.debug("Session file rename successful", {
          session: typedArgs.sessionId,
          originalPath: typedArgs.path,
          newName: typedArgs.newName,
          targetPath,
          resolvedPath,
          targetResolvedPath,
          overwrite: typedArgs.overwrite,
        });

        const originalResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          resolvedPath
        );
        const newResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          targetResolvedPath
        );

        return createSuccessResponse({
          path: targetPath,
          session: typedArgs.sessionId,
          originalPath: typedArgs.path,
          newPath: targetPath,
          newName: typedArgs.newName,
          originalResolvedPath: originalResolvedPath_rel,
          newResolvedPath: newResolvedPath_rel,
          renamed: true,
          overwritten: targetExists,
        });
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "rename_file",
          path: `${typedArgs.path} -> ${typedArgs.newName}`,
          session: typedArgs.sessionId,
        };

        log.error("Session file rename failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          newName: typedArgs.newName,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), undefined, {
          session: typedArgs.sessionId,
          path: typedArgs.path,
        });
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
