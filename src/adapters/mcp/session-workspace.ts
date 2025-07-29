/**
 * MCP adapter for session workspace operations
 * Provides session-scoped workspace tools that enforce workspace isolation
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { readFile, writeFile, mkdir, access, readdir, unlink, stat } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { createSessionProvider, type SessionProviderInterface } from "../../domain/session";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import {
  SessionFileReadSchema,
  SessionFileOperationSchema,
  SessionFileWriteSchema,
  SessionDirectoryListSchema,
  SessionFileExistsSchema,
  SessionFileDeleteSchema,
  SessionDirectoryCreateSchema,
  SessionGrepSearchSchema,
} from "./schemas/common-parameters";
import {
  createFileReadResponse,
  createErrorResponse,
  createFileOperationResponse,
  //   createDirectoryListResponse,
} from "./schemas/common-responses";

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
      linesShown: `1-${totalLines}`,
    };
  }

  // Determine actual start and end lines
  const actualStartLine = Math.max(1, options.startLine || 1);
  const actualEndLine = Math.min(totalLines, options.endLine || totalLines);

  // Extract the selected lines (convert to 0-based indexing)
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
 * Registers session workspace tools with the MCP command mapper
 */
export function registerSessionWorkspaceTools(commandMapper: CommandMapper): void {
  const pathResolver = createPathResolver();

  // Session read file tool
  commandMapper.addCommand({
    name: "session.read_file",
    description: "Read a file within a session workspace with optional line range support",
    parameters: SessionFileReadSchema,
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        const rawContent = await readFile(resolvedPath, "utf8");

        // Process content with line range support
        const processed = processFileContentWithLineRange(rawContent, {
          startLine: args.start_line_one_indexed,
          endLine: args.end_line_one_indexed_inclusive,
          shouldReadEntireFile: args.should_read_entire_file,
          filePath: args.path,
        });

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          resolvedPath
        );

        log.debug("Session file read successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          contentLength: rawContent.length,
          linesShown: processed.linesShown,
          totalLines: processed.totalLines,
        });

        return createFileReadResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relativeResolvedPath,
          },
          {
            content: processed.content,
            totalLines: processed.totalLines,
            linesRead:
              args.start_line_one_indexed && args.end_line_one_indexed_inclusive
                ? {
                    start: args.start_line_one_indexed,
                    end: args.end_line_one_indexed_inclusive,
                  }
                : undefined,
            linesShown: processed.linesShown,
            omittedContent: processed.summary ? { summary: processed.summary } : undefined,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file read failed", {
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

  // Session write file tool
  commandMapper.addCommand({
    name: "session.write_file",
    description: "Write content to a file within a session workspace",
    parameters: SessionFileWriteSchema,
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);

        // Create parent directories if requested and they don't exist
        if (args.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        await writeFile(resolvedPath, args.content, "utf8");

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          resolvedPath
        );

        log.debug("Session file write successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          contentLength: args.content.length,
          createdDirs: args.createDirs,
        });

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relativeResolvedPath,
          },
          {
            bytesWritten: args.content.length,
            created: true, // File is being written
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file write failed", {
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

  // Session list directory tool
  commandMapper.addCommand({
    name: "session.list_directory",
    description: "List contents of a directory within a session workspace",
    parameters: SessionDirectoryListSchema,
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

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(args.sessionName),
          resolvedPath
        );

        log.debug("Session directory list successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return createDirectoryListResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relativeResolvedPath,
          },
          {
            files: files.sort(),
            directories: directories.sort(),
            totalEntries: files.length + directories.length,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory list failed", {
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

  // Session file exists tool
  commandMapper.addCommand({
    name: "session.file_exists",
    description: "Check if a file or directory exists within a session workspace",
    parameters: SessionFileExistsSchema,
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
        log.error("Session file exists check failed", {
          session: args.sessionName,
          path: args.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: args.path,
          session: args.sessionName,
        };
      }
    },
  });

  // Session delete file tool
  commandMapper.addCommand({
    name: "session.delete_file",
    description: "Delete a file within a session workspace",
    parameters: SessionFileDeleteSchema,
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
        log.error("Session file delete failed", {
          session: args.sessionName,
          path: args.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: args.path,
          session: args.sessionName,
        };
      }
    },
  });

  // Session create directory tool
  commandMapper.addCommand({
    name: "session.create_directory",
    description: "Create a directory within a session workspace",
    parameters: SessionDirectoryCreateSchema,
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
        log.error("Session directory create failed", {
          session: args.sessionName,
          path: args.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: args.path,
          session: args.sessionName,
        };
      }
    },
  });

  // Session grep search tool
  commandMapper.addCommand({
    name: "session.grep_search",
    description: "Search for patterns in files within a session workspace using regex",
    parameters: SessionGrepSearchSchema,
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(args.sessionName);

        // Build ripgrep command arguments
        const rgArgs = [
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--max-count",
          "50", // Limit to 50 matches as per Cursor behavior
          args.case_sensitive ? "--case-sensitive" : "--ignore-case",
        ];

        // Add include pattern if specified
        if (args.include_pattern) {
          rgArgs.push("--glob", args.include_pattern);
        }

        // Add exclude pattern if specified
        if (args.exclude_pattern) {
          rgArgs.push("--glob", `!${args.exclude_pattern}`);
        }

        // Add the search pattern and directory
        rgArgs.push(args.query, sessionWorkspacePath);

        // Execute ripgrep
        const proc = Bun.spawn(["rg", ...rgArgs], {
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const errorOutput = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0 && proc.exitCode !== 1) {
          // Exit code 1 means no matches found, which is normal
          // Other exit codes indicate actual errors
          throw new Error(`Ripgrep search failed: ${errorOutput}`);
        }

        // Parse ripgrep output into Cursor-compatible format
        const results: string[] = [];
        if (output.trim()) {
          const lines = output.trim().split("\n");
          let currentFile = "";

          for (const line of lines) {
            // ripgrep output format: path:line_number:content
            const match = line.match(/^([^:]+):(\d+):(.*)$/);
            if (match && match[1] && match[2] && match[3] !== undefined) {
              const [, filePath, lineNumber, content] = match;

              // Convert to absolute file:// URL format like Cursor
              const absolutePath = filePath.startsWith("/")
                ? filePath
                : `${sessionWorkspacePath}/${filePath}`;
              const fileUrl = `file://${absolutePath}`;

              // Add file header if it's a new file
              if (currentFile !== fileUrl) {
                currentFile = fileUrl;
                results.push(`File: ${fileUrl}`);
              }

              results.push(`Line ${lineNumber}: ${content}`);
            }
          }
        }

        // Add "more results available" message if we hit the limit
        const resultCount = results.filter((line) => line.startsWith("Line ")).length;
        if (resultCount >= 50) {
          results.push(
            "NOTE: More results are available, but aren't shown here. If you need to, please refine the search query or restrict the scope."
          );
        }

        log.debug("Session grep search successful", {
          session: args.sessionName,
          query: args.query,
          caseSensitive: args.case_sensitive,
          includePattern: args.include_pattern,
          excludePattern: args.exclude_pattern,
          resultCount,
        });

        return {
          success: true,
          results: results.join("\n\n"),
          session: args.sessionName,
          query: args.query,
          matchCount: resultCount,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session grep search failed", {
          session: args.sessionName,
          query: args.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.sessionName,
          query: args.query,
        };
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
