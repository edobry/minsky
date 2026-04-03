/**
 * MCP adapter for session workspace operations
 * Provides session-scoped workspace tools that enforce workspace isolation
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { readFile, writeFile, mkdir, readdir, unlink, stat } from "fs/promises";
import { dirname, relative } from "path";
import { log } from "../../utils/logger";
import { SessionPathResolver } from "../../domain/session/session-path-resolver";
import { getErrorMessage } from "../../errors/index";
import {
  FileReadSchema,
  BaseFileOperationSchema,
  FileWriteSchema,
  DirectoryListSchema,
  FileExistsSchema,
  FileDeleteSchema,
  DirectoryCreateSchema,
  GrepSearchSchema,
  FileReadParameters,
  FileWriteParameters,
  DirectoryListParameters,
  FileExistsParameters,
  FileDeleteParameters,
  DirectoryCreateParameters,
  GrepSearchParameters,
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
    parameters: FileReadSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as FileReadParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);
        await pathResolver.validatePathExists(resolvedPath);

        const rawContent = await readFile(resolvedPath, "utf8");

        // Process content with line range support
        const processed = processFileContentWithLineRange(rawContent as string, {
          startLine: typedArgs.start_line_one_indexed,
          endLine: typedArgs.end_line_one_indexed_inclusive,
          shouldReadEntireFile: typedArgs.should_read_entire_file,
          filePath: typedArgs.path,
        });

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
          resolvedPath
        );

        log.debug("Session file read successful", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
          contentLength: rawContent.length,
          linesShown: processed.linesShown,
          totalLines: processed.totalLines,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relativeResolvedPath,
          content: processed.content,
          totalLines: processed.totalLines,
          linesRead:
            typedArgs.start_line_one_indexed && typedArgs.end_line_one_indexed_inclusive
              ? {
                  start: typedArgs.start_line_one_indexed,
                  end: typedArgs.end_line_one_indexed_inclusive,
                }
              : undefined,
          linesShown: processed.linesShown,
          omittedContent: processed.summary ? { summary: processed.summary } : undefined,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file read failed", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionName,
        });
      }
    },
  });

  // Session write file tool
  commandMapper.addCommand({
    name: "session.write_file",
    description: "Write content to a file within a session workspace",
    parameters: FileWriteSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as FileWriteParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);

        // Create parent directories if requested and they don't exist
        if (typedArgs.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        await writeFile(resolvedPath, typedArgs.content, "utf8");

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
          resolvedPath
        );

        log.debug("Session file write successful", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
          contentLength: typedArgs.content.length,
          createdDirs: typedArgs.createDirs,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relativeResolvedPath,
          bytesWritten: typedArgs.content.length,
          created: true, // File is being written
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file write failed", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionName,
        });
      }
    },
  });

  // Session list directory tool
  commandMapper.addCommand({
    name: "session.list_directory",
    description: "List contents of a directory within a session workspace",
    parameters: DirectoryListSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as DirectoryListParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);
        await pathResolver.validatePathExists(resolvedPath);

        const entries = await readdir(resolvedPath, { withFileTypes: true });

        const files: string[] = [];
        const directories: string[] = [];

        for (const entry of entries) {
          // Skip hidden files unless explicitly requested
          if (!typedArgs.showHidden && entry.name.startsWith(".")) {
            continue;
          }

          if (entry.isDirectory()) {
            directories.push(entry.name);
          } else {
            files.push(entry.name);
          }
        }

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
          resolvedPath
        );

        log.debug("Session directory list successful", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relativeResolvedPath,
          files: files.sort(),
          directories: directories.sort(),
          totalEntries: files.length + directories.length,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory list failed", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionName,
        });
      }
    },
  });

  // Session file exists tool
  commandMapper.addCommand({
    name: "session.file_exists",
    description: "Check if a file or directory exists within a session workspace",
    parameters: FileExistsSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as FileExistsParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);

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
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
          exists,
          isFile,
          isDirectory,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
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
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionName,
        };
      }
    },
  });

  // Session delete file tool
  commandMapper.addCommand({
    name: "session.delete_file",
    description: "Delete a file within a session workspace",
    parameters: FileDeleteSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as FileDeleteParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);
        await pathResolver.validatePathExists(resolvedPath);

        // Additional safety check - ensure it's a file, not a directory
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(
            `Path "${typedArgs.path}" is not a file - use appropriate directory deletion tools`
          );
        }

        await unlink(resolvedPath);

        log.debug("Session file delete successful", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
            resolvedPath
          ),
          deleted: true,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file delete failed", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionName,
        };
      }
    },
  });

  // Session create directory tool
  commandMapper.addCommand({
    name: "session.create_directory",
    description: "Create a directory within a session workspace",
    parameters: DirectoryCreateSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as DirectoryCreateParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionName, typedArgs.path);

        await mkdir(resolvedPath, { recursive: typedArgs.recursive });

        log.debug("Session directory create successful", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          resolvedPath,
          recursive: typedArgs.recursive,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionName,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionName),
            resolvedPath
          ),
          created: true,
          recursive: typedArgs.recursive,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory create failed", {
          session: typedArgs.sessionName,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionName,
        };
      }
    },
  });

  // Session grep search tool
  commandMapper.addCommand({
    name: "session.grep_search",
    description: "Search for patterns in files within a session workspace using regex",
    parameters: GrepSearchSchema,
    handler: async (args): Promise<Record<string, any>> => {
      const typedArgs = args as GrepSearchParameters;
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(
          typedArgs.sessionName
        );

        // Build ripgrep command arguments
        const rgArgs = [
          "--line-number",
          "--no-heading",
          "--color",
          "never",
          "--max-count",
          "50", // Limit to 50 matches as per Cursor behavior
          typedArgs.case_sensitive ? "--case-sensitive" : "--ignore-case",
        ];

        // Add include pattern if specified
        if (typedArgs.include_pattern) {
          rgArgs.push("--glob", typedArgs.include_pattern);
        }

        // Add exclude pattern if specified
        if (typedArgs.exclude_pattern) {
          rgArgs.push("--glob", `!${typedArgs.exclude_pattern}`);
        }

        // Add the search pattern and directory
        rgArgs.push(typedArgs.query, sessionWorkspacePath);

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
            if (match && match[1]) {
              const filePath = match[1] || "";
              const lineNumber = match[2] || "";
              const content = match[3] || "";

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
          session: typedArgs.sessionName,
          query: typedArgs.query,
          caseSensitive: typedArgs.case_sensitive,
          includePattern: typedArgs.include_pattern,
          excludePattern: typedArgs.exclude_pattern,
          resultCount,
        });

        return {
          success: true,
          results: results.join("\n\n"),
          session: typedArgs.sessionName,
          query: typedArgs.query,
          matchCount: resultCount,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session grep search failed", {
          session: typedArgs.sessionName,
          query: typedArgs.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: typedArgs.sessionName,
          query: typedArgs.query,
        };
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
