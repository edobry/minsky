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
 * Registers session workspace tools with the MCP command mapper
 */
export function registerSessionWorkspaceTools(commandMapper: CommandMapper): void {
  const pathResolver = createPathResolver();

  // Session read file tool
  commandMapper.addCommand({
    name: "session_read_file",
    description: "Read a file within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);
        await pathResolver.validatePathExists(resolvedPath);

        const content = await readFile(resolvedPath, "utf8");

        log.debug("Session file read successful", {
          session: args.session,
          path: args.path,
          resolvedPath,
          contentLength: content.length,
        });

        return {
          success: true,
          content,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
            resolvedPath
          ),
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file read failed", {
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
    },
  });

  // Session write file tool
  commandMapper.addCommand({
    name: "session_write_file",
    description: "Write content to a file within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file within the session workspace"),
      content: z.string().describe("Content to write to the file"),
      createDirs: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);

        // Create parent directories if requested and they don't exist
        if (args.createDirs) {
          const parentDir = dirname(resolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        await writeFile(resolvedPath, args.content, "utf8");

        log.debug("Session file write successful", {
          session: args.session,
          path: args.path,
          resolvedPath,
          contentLength: args.content.length,
          createdDirs: args.createDirs,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
            resolvedPath
          ),
          bytesWritten: args.content.length,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file write failed", {
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
    },
  });

  // Session list directory tool
  commandMapper.addCommand({
    name: "session_list_directory",
    description: "List contents of a directory within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
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
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);
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
          session: args.session,
          path: args.path,
          resolvedPath,
          fileCount: files.length,
          directoryCount: directories.length,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
            resolvedPath
          ),
          files: files.sort(),
          directories: directories.sort(),
          totalEntries: files.length + directories.length,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory list failed", {
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
    },
  });

  // Session file exists tool
  commandMapper.addCommand({
    name: "session_file_exists",
    description: "Check if a file or directory exists within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to check within the session workspace"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);

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
          session: args.session,
          path: args.path,
          resolvedPath,
          exists,
          isFile,
          isDirectory,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
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
    },
  });

  // Session delete file tool
  commandMapper.addCommand({
    name: "session_delete_file",
    description: "Delete a file within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the file to delete within the session workspace"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);
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
          session: args.session,
          path: args.path,
          resolvedPath,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
            resolvedPath
          ),
          deleted: true,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session file delete failed", {
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
    },
  });

  // Session create directory tool
  commandMapper.addCommand({
    name: "session_create_directory",
    description: "Create a directory within a session workspace",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      path: z.string().describe("Path to the directory to create within the session workspace"),
      recursive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const resolvedPath = await pathResolver.resolvePath(args.session, args.path);

        await mkdir(resolvedPath, { recursive: args.recursive });

        log.debug("Session directory create successful", {
          session: args.session,
          path: args.path,
          resolvedPath,
          recursive: args.recursive,
        });

        return {
          success: true,
          path: args.path,
          session: args.session,
          resolvedPath: relative(
            await pathResolver.getSessionWorkspacePath(args.session),
            resolvedPath
          ),
          created: true,
          recursive: args.recursive,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session directory create failed", {
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
    },
  });

  // Session grep search tool
  commandMapper.addCommand({
    name: "session_grep_search",
    description: "Search for patterns in files within a session workspace using regex",
    parameters: z.object({
      session: z.string().describe("Session identifier (name or task ID)"),
      query: z.string().describe("Regex pattern to search for"),
      case_sensitive: z.boolean().optional().default(false).describe("Whether the search should be case sensitive"),
      include_pattern: z.string().optional().describe("Glob pattern for files to include (e.g. '*.ts' for TypeScript files)"),
      exclude_pattern: z.string().optional().describe("Glob pattern for files to exclude"),
    }),
    handler: async (args): Promise<Record<string, any>> => {
      try {
        const sessionWorkspacePath = await pathResolver.getSessionWorkspacePath(args.session);
        
        // Build ripgrep command arguments
        const rgArgs = [
          "--line-number",
          "--no-heading", 
          "--color", "never",
          "--max-count", "50", // Limit to 50 matches as per Cursor behavior
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
              const absolutePath = filePath.startsWith("/") ? filePath : `${sessionWorkspacePath}/${filePath}`;
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
        const resultCount = results.filter(line => line.startsWith("Line ")).length;
        if (resultCount >= 50) {
          results.push("NOTE: More results are available, but aren't shown here. If you need to, please refine the search query or restrict the scope.");
        }

        log.debug("Session grep search successful", {
          session: args.session,
          query: args.query,
          caseSensitive: args.case_sensitive,
          includePattern: args.include_pattern,
          excludePattern: args.exclude_pattern,
          resultCount,
        });

        return {
          success: true,
          results: results.join("\n\n"),
          session: args.session,
          query: args.query,
          matchCount: resultCount,
        };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session grep search failed", {
          session: args.session,
          query: args.query,
          error: errorMessage,
        });

        return {
          success: false,
          error: errorMessage,
          session: args.session,
          query: args.query,
        };
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
