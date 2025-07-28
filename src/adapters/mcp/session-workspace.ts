/**
 * MCP adapter for session workspace operations
 * Provides session-scoped workspace tools that enforce workspace isolation
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { z } from "zod";
import { readFile, writeFile, mkdir, access, readdir, unlink, stat } from "fs/promises";
import { join, resolve, relative, dirname } from "path";
import { createSessionProvider, type SessionProviderInterface } from "../../domain/session";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

// Import new schemas and utilities
// TODO: Fix import path for schemas
// import {
//   SessionFileReadSchema,
//   SessionFileWriteSchema,
//   SessionDirectoryListSchema,
//   SessionFileExistsSchema,
//   SessionFileDeleteSchema,
//   SessionDirectoryCreateSchema,
//   SessionGrepSearchSchema,
// } from "./schemas/common-parameters";

// TODO: Fix import path for response utilities
// import {
//   createFileReadResponse,
//   createFileOperationResponse,
//   createErrorResponse,
// } from "./schemas/common-responses";

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

    return session.repoPath;
  }

  /**
   * Resolve relative path within session workspace
   */
  async resolvePath(sessionId: string, filePath: string): Promise<string> {
    const workspacePath = await this.getSessionWorkspacePath(sessionId);
    const resolvedPath = resolve(workspacePath, filePath);

    // Security check: ensure resolved path is within workspace
    if (!resolvedPath.startsWith(workspacePath)) {
      throw new Error(`Path "${filePath}" resolves outside session workspace`);
    }

    return resolvedPath;
  }

  /**
   * Validate that a path exists
   */
  async validatePathExists(fullPath: string): Promise<void> {
    try {
      await access(fullPath);
    } catch {
      throw new Error(`Path "${fullPath}" does not exist`);
    }
  }
}

/**
 * Process file content with line range support
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
  linesShown: number;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;

  // If reading entire file or no range specified
  if (options.shouldReadEntireFile || (!options.startLine && !options.endLine)) {
    return {
      content,
      totalLines,
      linesShown: totalLines,
    };
  }

  // Handle line range
  const startLine = Math.max(1, options.startLine || 1);
  const endLine = Math.min(totalLines, options.endLine || totalLines);

  // Convert to 0-based indexing
  const startIndex = startLine - 1;
  const endIndex = endLine;

  const selectedLines = lines.slice(startIndex, endIndex);
  const processedContent = selectedLines.join("\n");

  // Add context information if content was truncated
  let finalContent = processedContent;
  if (startLine > 1 || endLine < totalLines) {
    const contextInfo = [];
    if (startLine > 1) {
      contextInfo.push(`... (showing lines ${startLine}-${endLine} of ${totalLines})`);
    }
    if (endLine < totalLines) {
      contextInfo.push(`... (${totalLines - endLine} lines omitted)`);
    }
    if (contextInfo.length > 0) {
      finalContent = `${contextInfo.join("\n")}\n${processedContent}`;
    }
  }

  return {
    content: finalContent,
    totalLines,
    linesShown: selectedLines.length,
  };
}

/**
 * Register session workspace tools with the command mapper
 */
export function registerSessionWorkspaceTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

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

        log.debug("Session directory list successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relative(
              await pathResolver.getSessionWorkspacePath(args.sessionName),
              resolvedPath
            ),
          },
          {
            files,
            directories,
            totalItems: files.length + directories.length,
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
        let isDirectory = false;
        let isFile = false;

        try {
          const stats = await stat(resolvedPath);
          exists = true;
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          // File doesn't exist, which is fine
        }

        log.debug("Session file exists check successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
          exists,
          isDirectory,
          isFile,
        });

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relative(
              await pathResolver.getSessionWorkspacePath(args.sessionName),
              resolvedPath
            ),
          },
          {
            exists,
            isDirectory,
            isFile,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file exists check failed", {
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

  // Session delete file tool
  commandMapper.addCommand({
    name: "session.delete_file",
    description: "Delete a file within a session workspace",
    parameters: SessionFileDeleteSchema,
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.sessionName, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        await unlink(resolvedPath);

        log.debug("Session file delete successful", {
          session: args.sessionName,
          path: args.path,
          resolvedPath,
        });

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relative(
              await pathResolver.getSessionWorkspacePath(args.sessionName),
              resolvedPath
            ),
          },
          {
            deleted: true,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file delete failed", {
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

        return createFileOperationResponse(
          {
            path: args.path,
            session: args.sessionName,
            resolvedPath: relative(
              await pathResolver.getSessionWorkspacePath(args.sessionName),
              resolvedPath
            ),
          },
          {
            created: true,
            recursive: args.recursive,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory create failed", {
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

  // Session grep search tool
  commandMapper.addCommand({
    name: "session.grep_search",
    description: "Search for patterns in files within a session workspace using regex",
    parameters: SessionGrepSearchSchema,
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const workspacePath = await pathResolver.getSessionWorkspacePath(args.sessionName);

        // Build grep command
        const grepArgs = ["grep", "-rn"];

        if (!args.case_sensitive) {
          grepArgs.push("-i");
        }

        if (args.include_pattern) {
          grepArgs.push("--include", args.include_pattern);
        }

        if (args.exclude_pattern) {
          grepArgs.push("--exclude", args.exclude_pattern);
        }

        grepArgs.push(args.query, workspacePath);

        // Import exec dynamically to avoid circular dependency
        const { exec } = await import("../../utils/exec");

        const { stdout } = await exec(grepArgs.join(" "), {
          cwd: workspacePath,
          timeout: 30000,
        });

        const matches = stdout
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(0, 50) // Limit to 50 matches
          .map((line) => {
            const colonIndex = line.indexOf(":");
            const secondColonIndex = line.indexOf(":", colonIndex + 1);

            if (colonIndex === -1 || secondColonIndex === -1) return null;

            const filePath = line.substring(0, colonIndex);
            const lineNumber = parseInt(line.substring(colonIndex + 1, secondColonIndex));
            const content = line.substring(secondColonIndex + 1);

            return {
              file: relative(workspacePath, join(workspacePath, filePath)),
              line: lineNumber,
              content: content.trim(),
            };
          })
          .filter((match) => match !== null);

        log.debug("Session grep search successful", {
          session: args.sessionName,
          query: args.query,
          matchCount: matches.length,
        });

        return createFileOperationResponse(
          {
            path: ".",
            session: args.sessionName,
            resolvedPath: ".",
          },
          {
            matches,
            query: args.query,
            totalMatches: matches.length,
          }
        );
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session grep search failed", {
          session: args.sessionName,
          query: args.query,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, {
          session: args.sessionName,
        });
      }
    },
  });
}
