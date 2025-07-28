/**
 * MCP adapter for session file operations
 * Provides session-scoped file operations that enforce workspace isolation
 */
import { readFile, writeFile, mkdir, access, readdir, unlink, stat, rename } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { createSessionProvider, type SessionProviderInterface } from "../../domain/session";
import type { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { FileOperationResponse } from "../../types/semantic-errors";
import {
  SessionFileReadSchema,
  SessionFileWriteSchema,
  SessionDirectoryListSchema,
  SessionFileExistsSchema,
  SessionFileDeleteSchema,
  SessionFileMoveSchema,
  SessionFileRenameSchema,
  SessionDirectoryCreateSchema,
  SessionGrepSearchSchema,
  type SessionFileRead,
  type SessionFileWrite,
  type SessionDirectoryList,
  type FileOperationResponse as SharedFileOperationResponse,
} from "./schemas/common-parameters";
import { createFileOperationResponse, createErrorResponse } from "./schemas/common-responses";

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
  const startLine = Math.max(1, options.startLine || 1);
  const endLine = Math.min(totalLines, options.endLine || startLine + 249); // Default to 250 line window

  // For all files, respect line ranges but may expand for better context
  let actualStartLine = startLine;
  let actualEndLine = endLine;

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
 * Session path resolver class for enforcing workspace boundaries
 */
export class SessionPathResolver {
  private sessionDB: SessionProviderInterface;

  constructor() {
    this.sessionDB = createSessionProvider();
  }

  /**
   * Resolve session workspace path for a given session
   */
  async getSessionWorkspacePath(sessionId: string): Promise<string> {
    const session = await this.sessionDB.getSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }

    return await this.sessionDB.getRepoPath(session);
  }

  /**
   * Resolve and validate a path within a session workspace
   */
  async resolvePath(sessionId: string, inputPath: string): Promise<string> {
    const sessionWorkspace = await this.getSessionWorkspacePath(sessionId);

    // Convert relative paths to absolute within session workspace
    let targetPath: string;
    if (inputPath.startsWith("/")) {
      // Absolute path - ensure it's within session workspace
      targetPath = inputPath;
    } else {
      // Relative path - resolve within session workspace
      targetPath = resolve(sessionWorkspace, inputPath);
    }

    // Normalize the path to handle .. and . components
    const normalizedPath = resolve(targetPath);
    const normalizedWorkspace = resolve(sessionWorkspace);

    // Security check: ensure the resolved path is within the session workspace
    if (
      !normalizedPath.startsWith(`${normalizedWorkspace}/`) &&
      normalizedPath !== normalizedWorkspace
    ) {
      throw new Error(
        `Path "${inputPath}" resolves outside session workspace. ` +
          `Session workspace: ${sessionWorkspace}, Resolved path: ${normalizedPath}`
      );
    }

    return normalizedPath;
  }

  /**
   * Validate that a path exists and is accessible
   */
  async validatePathExists(path: string): Promise<void> {
    try {
      await access(path);
    } catch (error) {
      throw new Error(`Path does not exist or is not accessible: ${path}`);
    }
  }
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
    parameters: SessionFileMoveSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      try {
        const sourceResolvedPath = await pathResolver.resolvePath(
          args.sessionName,
          args.sourcePath
        );
        const targetResolvedPath = await pathResolver.resolvePath(
          args.sessionName,
          args.targetPath
        );

        // Validate source file exists
        await pathResolver.validatePathExists(sourceResolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const sourceStats = await stat(sourceResolvedPath);
        if (!sourceStats.isFile()) {
          throw new Error(
            `Source path "${args.sourcePath}" is not a file - use appropriate directory tools`
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

        if (targetExists && !args.overwrite) {
          throw new Error(
            `Target path "${args.targetPath}" already exists. Set overwrite: true to replace it.`
          );
        }

        // Create parent directories if requested and they don't exist
        if (args.createDirs) {
          const parentDir = dirname(targetResolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        // Perform the atomic move operation
        await rename(sourceResolvedPath, targetResolvedPath);

        log.debug("Session file move successful", {
          session: args.sessionName,
          sourcePath: args.sourcePath,
          targetPath: args.targetPath,
          sourceResolvedPath,
          targetResolvedPath,
          overwrite: args.overwrite,
          createdDirs: args.createDirs,
        });

        const sourceResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          sourceResolvedPath
        );
        const targetResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          targetResolvedPath
        );

        return createFileOperationResponse(
          {
            path: args.targetPath,
            session: args.sessionName,
          },
          {
            sourcePath: args.sourcePath,
            targetPath: args.targetPath,
            sourceResolvedPath: sourceResolvedPath_rel,
            targetResolvedPath: targetResolvedPath_rel,
            moved: true,
            overwritten: targetExists,
          }
        );
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "move_file",
          path: `${args.sourcePath} -> ${args.targetPath}`,
          session: args.sessionName,
          createDirs: args.createDirs,
        };

        log.error("Session file move failed", {
          session: args.sessionName,
          sourcePath: args.sourcePath,
          targetPath: args.targetPath,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), {
          session: args.sessionName,
          path: args.sourcePath,
        });
      }
    },
  });

  // Session rename file tool
  commandMapper.addCommand({
    name: "session.rename_file",
    description: "Rename a file within a session workspace",
    parameters: SessionFileRenameSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        // Validate source file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(`Path "${args.path}" is not a file - use appropriate directory tools`);
        }

        // Construct target path by replacing the filename
        const sourceDir = dirname(resolvedPath);
        const targetResolvedPath = join(sourceDir, args.newName);
        const targetPath = join(dirname(args.path), args.newName);

        // Validate that target path is still within session workspace
        await pathResolver.resolvePath(args.sessionName, targetPath);

        // Check if target already exists and handle overwrite logic
        let targetExists = false;
        try {
          await stat(targetResolvedPath);
          targetExists = true;
        } catch (error) {
          // Target doesn't exist - that's fine
          targetExists = false;
        }

        if (targetExists && !args.overwrite) {
          throw new Error(
            `Target file "${args.newName}" already exists in the same directory. Set overwrite: true to replace it.`
          );
        }

        // Perform the atomic rename operation
        await rename(resolvedPath, targetResolvedPath);

        log.debug("Session file rename successful", {
          session: args.sessionName,
          originalPath: args.path,
          newName: args.newName,
          targetPath,
          resolvedPath,
          targetResolvedPath,
          overwrite: args.overwrite,
        });

        const originalResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          resolvedPath
        );
        const newResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          targetResolvedPath
        );

        return createFileOperationResponse(
          {
            path: targetPath,
            session: args.sessionName,
          },
          {
            originalPath: args.path,
            newPath: targetPath,
            newName: args.newName,
            originalResolvedPath: originalResolvedPath_rel,
            newResolvedPath: newResolvedPath_rel,
            renamed: true,
            overwritten: targetExists,
          }
        );
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "rename_file",
          path: `${args.path} -> ${args.newName}`,
          session: args.sessionName,
        };

        log.error("Session file rename failed", {
          session: args.sessionName,
          path: args.path,
          newName: args.newName,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), {
          session: args.sessionName,
          path: args.path,
        });
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
