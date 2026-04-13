/**
 * MCP adapter for session workspace operations
 * Provides session-scoped workspace tools that enforce workspace isolation
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { readFile, writeFile, mkdir, readdir, unlink, stat } from "fs/promises";
import { dirname, relative } from "path";
import { z } from "zod";
import { log } from "../../utils/logger";
import { SessionPathResolver } from "../../domain/session/session-path-resolver";
import { getErrorMessage } from "../../errors/index";
import {
  FileReadSchema,
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
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as FileReadParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);
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
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          resolvedPath
        );

        log.debug("Session file read successful", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
          contentLength: rawContent.length,
          linesShown: processed.linesShown,
          totalLines: processed.totalLines,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionId,
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
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionId,
        });
      }
    },
  });

  // Session write file tool
  commandMapper.addCommand({
    name: "session.write_file",
    description: "Write content to a file within a session workspace",
    parameters: FileWriteSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as FileWriteParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);

        // Create parent directories if requested and they don't exist
        if (typedArgs.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        await writeFile(resolvedPath, typedArgs.content, "utf8");

        const relativeResolvedPath = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          resolvedPath
        );

        log.debug("Session file write successful", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
          contentLength: typedArgs.content.length,
          createdDirs: typedArgs.createDirs,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionId,
          resolvedPath: relativeResolvedPath,
          bytesWritten: typedArgs.content.length,
          created: true, // File is being written
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file write failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionId,
        });
      }
    },
  });

  // Session list directory tool
  commandMapper.addCommand({
    name: "session.list_directory",
    description: "List contents of a directory within a session workspace",
    parameters: DirectoryListSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as DirectoryListParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);
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
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          resolvedPath
        );

        log.debug("Session directory list successful", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return createSuccessResponse({
          path: typedArgs.path,
          session: typedArgs.sessionId,
          resolvedPath: relativeResolvedPath,
          files: files.sort(),
          directories: directories.sort(),
          totalEntries: files.length + directories.length,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory list failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return createErrorResponse(errorMessage, undefined, {
          path: typedArgs.path,
          session: typedArgs.sessionId,
        });
      }
    },
  });

  // Session file exists tool
  commandMapper.addCommand({
    name: "session.file_exists",
    description: "Check if a file or directory exists within a session workspace",
    parameters: FileExistsSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as FileExistsParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);

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
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
          exists,
          isFile,
          isDirectory,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionId,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
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
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionId,
        };
      }
    },
  });

  // Session delete file tool
  commandMapper.addCommand({
    name: "session.delete_file",
    description: "Delete a file within a session workspace",
    parameters: FileDeleteSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as FileDeleteParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);
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
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionId,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
            resolvedPath
          ),
          deleted: true,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file delete failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionId,
        };
      }
    },
  });

  // Session create directory tool
  commandMapper.addCommand({
    name: "session.create_directory",
    description: "Create a directory within a session workspace",
    parameters: DirectoryCreateSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as DirectoryCreateParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);

        await mkdir(resolvedPath, { recursive: typedArgs.recursive });

        log.debug("Session directory create successful", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          resolvedPath,
          recursive: typedArgs.recursive,
        });

        return {
          success: true,
          path: typedArgs.path,
          session: typedArgs.sessionId,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
            resolvedPath
          ),
          created: true,
          recursive: typedArgs.recursive,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory create failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          path: typedArgs.path,
          session: typedArgs.sessionId,
        };
      }
    },
  });

  // Session grep search tool
  commandMapper.addCommand({
    name: "session.grep_search",
    description: "Search for patterns in files within a session workspace using regex",
    parameters: GrepSearchSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as GrepSearchParameters;
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(
          typedArgs.sessionId
        );

        const limit = typedArgs.limit;
        const filesOnly = typedArgs.files_only;
        const maxContextLines = typedArgs.max_context_lines;

        // Build ripgrep command arguments
        const rgArgs = [
          "--color",
          "never",
          typedArgs.case_sensitive ? "--case-sensitive" : "--ignore-case",
        ];

        if (filesOnly) {
          // files-with-matches mode: just return file paths
          rgArgs.push("--files-with-matches");
        } else {
          rgArgs.push("--line-number", "--no-heading");
          if (maxContextLines > 0) {
            rgArgs.push("--context", String(maxContextLines));
          }
        }

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

        let resultCount = 0;
        let truncated = false;
        let totalMatches = 0;
        let resultsText = "";

        if (filesOnly) {
          // files_only mode: return unique file paths
          const allFiles = output.trim() ? output.trim().split("\n").filter(Boolean) : [];
          totalMatches = allFiles.length;
          const limitedFiles = allFiles.slice(0, limit);
          truncated = allFiles.length > limit;
          resultCount = limitedFiles.length;
          resultsText = limitedFiles.join("\n");
        } else {
          // Normal match mode: parse ripgrep output into structured format
          const results: string[] = [];
          if (output.trim()) {
            const lines = output.trim().split("\n");
            let currentFile = "";
            let matchLines = 0;

            for (const line of lines) {
              // Context separator lines (emitted between context groups by ripgrep)
              if (line === "--") {
                results.push("--");
                continue;
              }
              // ripgrep output format: path:line_number:content
              const match = line.match(/^([^:]+):(\d+):(.*)$/);
              if (match && match[1]) {
                totalMatches++;
                if (matchLines >= limit) {
                  // Count remaining matches without adding them
                  continue;
                }

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
                matchLines++;
              } else if (maxContextLines > 0) {
                // Context line (path-linenum-content format with dash separator)
                const contextMatch = line.match(/^([^:]+)-(\d+)-(.*)$/);
                if (contextMatch && matchLines < limit) {
                  results.push(`  ${contextMatch[3]}`);
                }
              }
            }

            truncated = totalMatches > limit;
            resultCount = matchLines;
          }

          resultsText = results.join("\n");
        }

        log.debug("Session grep search successful", {
          session: typedArgs.sessionId,
          query: typedArgs.query,
          caseSensitive: typedArgs.case_sensitive,
          includePattern: typedArgs.include_pattern,
          excludePattern: typedArgs.exclude_pattern,
          filesOnly,
          limit,
          maxContextLines,
          resultCount,
          truncated,
        });

        return {
          success: true,
          results: resultsText,
          session: typedArgs.sessionId,
          query: typedArgs.query,
          matchCount: resultCount,
          ...(truncated && { truncated: true, total_matches: totalMatches }),
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session grep search failed", {
          session: typedArgs.sessionId,
          query: typedArgs.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: typedArgs.sessionId,
          query: typedArgs.query,
        };
      }
    },
  });

  // Session diff tool
  const SessionDiffSchema = z.object({
    sessionId: z.string().describe("Session identifier (ID or task ID)"),
    path: z.string().optional().describe("Specific file or directory path to diff (optional)"),
    staged: z
      .boolean()
      .optional()
      .default(false)
      .describe("Show staged changes (git diff --cached) instead of unstaged changes"),
  });

  commandMapper.addCommand({
    name: "session.diff",
    description:
      "Show git diff output for a session workspace. Returns unstaged changes by default, or staged changes with staged=true.",
    parameters: SessionDiffSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as z.infer<typeof SessionDiffSchema>;
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(
          typedArgs.sessionId
        );

        const gitArgs = ["git", "diff"];
        if (typedArgs.staged) {
          gitArgs.push("--cached");
        }
        if (typedArgs.path) {
          gitArgs.push("--", typedArgs.path);
        }

        const proc = Bun.spawn(gitArgs, {
          cwd: sessionWorkspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const errorOutput = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
          throw new Error(`git diff failed: ${errorOutput}`);
        }

        log.debug("Session diff successful", {
          session: typedArgs.sessionId,
          staged: typedArgs.staged,
          path: typedArgs.path,
          outputLength: output.length,
        });

        return createSuccessResponse({
          session: typedArgs.sessionId,
          diff: output,
          staged: typedArgs.staged ?? false,
          isEmpty: output.trim().length === 0,
          ...(typedArgs.path && { path: typedArgs.path }),
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session diff failed", {
          session: typedArgs.sessionId,
          staged: typedArgs.staged,
          path: typedArgs.path,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: typedArgs.sessionId,
        };
      }
    },
  });

  // Session status tool
  const SessionStatusSchema = z.object({
    sessionId: z.string().describe("Session identifier (ID or task ID)"),
  });

  commandMapper.addCommand({
    name: "session.status",
    description:
      "Show git status for a session workspace. Returns modified, staged, and untracked files.",
    parameters: SessionStatusSchema,
    handler: async (args): Promise<Record<string, unknown>> => {
      const typedArgs = args as z.infer<typeof SessionStatusSchema>;
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(
          typedArgs.sessionId
        );

        const proc = Bun.spawn(["git", "status", "--porcelain=v1"], {
          cwd: sessionWorkspacePath,
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const errorOutput = await new Response(proc.stderr).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
          throw new Error(`git status failed: ${errorOutput}`);
        }

        // Parse porcelain output into structured data
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];

        const lines = output.trim() ? output.trim().split("\n") : [];
        for (const line of lines) {
          if (line.length < 3) continue;
          const x = line[0]; // staged status
          const y = line[1]; // unstaged status
          const filePath = line.slice(3);

          if (x === "?" && y === "?") {
            untracked.push(filePath);
          } else {
            if (x && x !== " " && x !== "?") {
              staged.push(filePath);
            }
            if (y && y !== " " && y !== "?") {
              unstaged.push(filePath);
            }
          }
        }

        log.debug("Session status successful", {
          session: typedArgs.sessionId,
          stagedCount: staged.length,
          unstagedCount: unstaged.length,
          untrackedCount: untracked.length,
        });

        return createSuccessResponse({
          session: typedArgs.sessionId,
          staged,
          unstaged,
          untracked,
          clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
          raw: output,
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session status failed", {
          session: typedArgs.sessionId,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: typedArgs.sessionId,
        };
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
