/**
 * MCP adapter for session file operations
 * Provides session-scoped file operations that enforce workspace isolation
 */
import { readFile, writeFile, mkdir, access, readdir, unlink, stat } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { z } from "zod";
import { createSessionProvider, type SessionProviderInterface } from "../../domain/session";
import type { CommandMapper } from "../../mcp/command-mapper";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { SemanticErrorClassifier, ErrorContext } from "../../utils/semantic-error-classifier";
import { FileOperationResponse } from "../../types/semantic-errors";

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
  if (totalLines <= 50 && (endLine - startLine + 1) < totalLines) {
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
    const before = actualStartLine > 1 ? `Lines 1-${actualStartLine - 1}: [Earlier content...]` : "";
    const after = actualEndLine < totalLines ? `Lines ${actualEndLine + 1}-${totalLines}: [Later content...]` : "";
    const parts = [before, after].filter(Boolean);
    if (parts.length > 0) {
      summary = `Outline of the rest of the file:\n${parts.join("\n")}`;
    }
  }

  return {
    content: resultContent,
    totalLines,
    linesShown: actualStartLine === actualEndLine ? `${actualStartLine}` : `${actualStartLine}-${actualEndLine}`,
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
  commandMapper.addCommand({
    name: "session_read_file",
    description: "Read a file within a session workspace with optional line range support",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
      start_line_one_indexed: z.number().min(1).optional().describe("The one-indexed line number to start reading from (inclusive)"),
      end_line_one_indexed_inclusive: z.number().min(1).optional().describe("The one-indexed line number to end reading at (inclusive)"),
      should_read_entire_file: z.boolean().optional().default(false).describe("Whether to read the entire file"),
      explanation: z.string().optional().describe("One sentence explanation of why this tool is being used"),
    }),
    handler: async (args): Promise<FileOperationResponse> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        const content = await readFile(resolvedPath, "utf8");

        // Process content with line range support
        const processed = processFileContentWithLineRange(content, {
          startLine: args.start_line_one_indexed,
          endLine: args.end_line_one_indexed_inclusive,
          shouldReadEntireFile: args.should_read_entire_file,
          filePath: args.path,
        });

        log.debug("Session file read successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          totalLines: processed.totalLines,
          linesShown: processed.linesShown,
          contentLength: processed.content.length,
        });

        // Build response content with header like Cursor does
        let responseContent = `Contents of ${args.path}, lines ${processed.linesShown}`;
        if (processed.totalLines > 0) {
          responseContent += ` (total ${processed.totalLines} lines)`;
        }
        responseContent += `:\n${processed.content}`;

        // Add summary if content was truncated
        if (processed.summary) {
          responseContent += `\n\n${processed.summary}`;
        }

        // Enhanced response format matching the specification
        const response: any = {
          success: true,
          content: responseContent,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          totalLines: processed.totalLines,
        };

        // Add line range metadata if applicable
        if (processed.linesShown !== "(entire file)" && !processed.linesShown.includes("entire file")) {
          const [start, end] = processed.linesShown.split("-").map(Number);
          response.linesRead = {
            start: start || Number(processed.linesShown),
            end: end || Number(processed.linesShown),
          };
        }

        // Add omitted content information if content was truncated
        if (processed.summary) {
          response.omittedContent = {
            summary: processed.summary,
          };
        }

        return response;
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "read_file",
          path: args.path,
          session: args.sessionName
        };

        log.error("Session file read failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });

  // Session write file tool
  commandMapper.addCommand({
    name: "session_write_file",
    description: "Write content to a file within a session workspace",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
      content: z.string().describe("Content to write to the file"),
      createDirs: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
    }),
    handler: async (args): Promise<FileOperationResponse> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        // Create parent directories if requested and they don't exist
        if (args.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        await writeFile(resolvedPath, args.content, "utf8");

        log.debug("Session file write successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          contentLength: args.content.length,
          createdDirs: args.createDirs,
        });

        return {
          success: true,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          bytesWritten: Buffer.from(args.content, "utf8").length,
        };
      } catch (error) {
        const errorContext: ErrorContext = {
          operation: "write_file",
          path: args.path,
          session: args.sessionName,
          createDirs: args.createDirs
        };

        log.error("Session file write failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });

  // Session list directory tool
  commandMapper.addCommand({
    name: "session_list_directory",
    description: "List contents of a directory within a session workspace",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z
        .string()
        .optional()
        .default(".")
        .describe("Path to the directory within the session workspace"),
      showHidden: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include hidden files (starting with .)"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        const entries = await readdir(resolvedPath, { withFileTypes: true });

        const files: string[] = [];
        const directories: string[] = [];

        for (const entry of entries) {
          // Skip hidden files unless explicitly requested
          if (!args.showHidden && entry.name.startsWith(".")) {
            continue;
          }

          if (entry.isDirectory()) {
            directories.push(entry.name);
          } else {
            files.push(entry.name);
          }
        }

        log.debug("Session directory list successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return {
          success: true,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          files: files.sort(),
          directories: directories.sort(),
          totalEntries: files.length + directories.length,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const errorContext: ErrorContext = {
          operation: "list_directory",
          path: args.path,
          session: args.sessionName
        };

        log.error("Session directory list failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });

  // Session file exists tool
  commandMapper.addCommand({
    name: "session_file_exists",
    description: "Check if a file or directory exists within a session workspace",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to check within the session workspace"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        let exists = false;
        let isFile = false;
        let isDirectory = false;
        let size: number | undefined;

        try {
          const stats = await stat(resolvedPath);
          exists = true;
          isFile = stats.isFile();
          isDirectory = stats.isDirectory();
          size = stats.size;
        } catch (error) {
          // File doesn't exist - that's fine, not an error
          exists = false;
        }

        log.debug("Session file exists check", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          exists,
          isFile,
          isDirectory,
        });

        return {
          success: true,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          exists,
          isFile,
          isDirectory,
          size,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const errorContext: ErrorContext = {
          operation: "file_exists",
          path: args.path,
          session: args.sessionName
        };

        log.error("Session file exists check failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });

  // Session delete file tool
  commandMapper.addCommand({
    name: "session_delete_file",
    description: "Delete a file within a session workspace",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file to delete within the session workspace"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        // Additional safety check - ensure it's a file, not a directory
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(
            `Path "${args.path}" is not a file - use appropriate directory deletion tools`
          );
        }

        await unlink(resolvedPath);

        log.debug("Session file delete successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
        });

        return {
          success: true,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          deleted: true,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const errorContext: ErrorContext = {
          operation: "delete_file",
          path: args.path,
          session: args.sessionName
        };

        log.error("Session file delete failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });

  // Session create directory tool
  commandMapper.addCommand({
    name: "session_create_directory",
    description: "Create a directory within a session workspace",
    parameters: z.object({
      sessionName: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the directory to create within the session workspace"),
      recursive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        await mkdir(resolvedPath, { recursive: args.recursive });

        log.debug("Session directory create successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          recursive: args.recursive,
        });

        return {
          success: true,
          path: args.path,
          session: args.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.sessionName),
            resolvedPath
          ),
          created: true,
          recursive: args.recursive,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const errorContext: ErrorContext = {
          operation: "create_directory",
          path: args.path,
          session: args.sessionName
        };

        log.error("Session directory create failed", {
          session: args.sessionName,
          path: args.path,
          error: getErrorMessage(error),
        });

        return SemanticErrorClassifier.classifyError(error, errorContext);
      }
    },
  });



  log.debug("Session file operation tools registered successfully");
}