import { z } from "zod";
import { promises as fs } from "fs";
import { resolve, dirname } from "path";
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { SessionDB } from "../../domain/session.js";
import { getCurrentSession } from "../../domain/workspace.js";
import { MinskyError } from "../../errors/base-errors.js";

/**
 * Session path resolver - handles secure path resolution within session workspaces
 */
export class SessionPathResolver {
  private sessionDb: SessionDB;
  private getCurrentSessionFn: () => Promise<string | null>;

  constructor(
    sessionDb: SessionDB = new SessionDB(),
    getCurrentSessionFn: () => Promise<string | null> = getCurrentSession
  ) {
    this.sessionDb = sessionDb;
    this.getCurrentSessionFn = getCurrentSessionFn;
  }

  /**
   * Resolve a relative path within a session workspace, ensuring it stays within bounds
   */
  async resolveSessionPath(sessionId: string, relativePath: string): Promise<string> {
    // Get the session workspace path
    const sessionWorkspace = await this.sessionDb.getSessionWorkdir(sessionId);
    if (!sessionWorkspace) {
      throw new MinskyError(`Session '${sessionId}' not found or has no workspace.`);
    }

    // Resolve the path relative to the session workspace
    const resolvedPath = resolve(sessionWorkspace, relativePath);

    // Ensure the resolved path is within the session workspace (prevent directory traversal)
    const normalizedSessionPath = resolve(sessionWorkspace);
    const normalizedResolvedPath = resolve(resolvedPath);

    if (
      !normalizedResolvedPath.startsWith(`${normalizedSessionPath}/`) &&
      normalizedResolvedPath !== normalizedSessionPath
    ) {
      throw new MinskyError(
        `Path '${relativePath}' resolves outside session workspace. ` +
          `Session workspace: ${normalizedSessionPath}, resolved path: ${normalizedResolvedPath}`
      );
    }

    return normalizedResolvedPath;
  }

  /**
   * Get current session from working directory
   */
  async getCurrentSessionId(): Promise<string> {
    const currentSession = await this.getCurrentSessionFn();
    if (!currentSession) {
      throw new MinskyError(
        "Not in a session workspace. Session file operations can only be used within session workspaces."
      );
    }
    return currentSession;
  }
}

/**
 * Registers session file operation tools with the MCP command mapper
 */
export function registerSessionFileTools(
  commandMapper: CommandMapper, 
  pathResolver?: SessionPathResolver
): void {
  const resolver = pathResolver || new SessionPathResolver();

  // Session read file tool
  commandMapper.addCommand({
    name: "session.read_file",
    description: "Read a file from the current session workspace with path validation",
    parameters: z.object({
      path: z.string().describe("Relative path to the file within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
    execute: async (args: { path: string; session?: string }) => {
      try {
        const sessionId = args.session || await resolver.getCurrentSessionId();
        const absolutePath = await resolver.resolveSessionPath(sessionId, args.path);
        
        const content = await fs.readFile(absolutePath, "utf-8");
        
        return {
          success: true,
          content,
          path: args.path,
          absolutePath,
          session: sessionId
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          path: args.path,
          session: args.session
        };
      }
    }
  });

  // Session write file tool
  commandMapper.addCommand({
    name: "session.write_file",
    description: "Write content to a file in the current session workspace with path validation",
    parameters: z.object({
      path: z.string().describe("Relative path to the file within the session workspace"),
      content: z.string().describe("Content to write to the file"),
      createDirectories: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
    execute: async (args: { path: string; content: string; createDirectories?: boolean; session?: string }) => {
      try {
        const sessionId = args.session || await resolver.getCurrentSessionId();
        const absolutePath = await resolver.resolveSessionPath(sessionId, args.path);
        
        // Create parent directories if requested
        if (args.createDirectories) {
          await fs.mkdir(dirname(absolutePath), { recursive: true });
        }
        
        await fs.writeFile(absolutePath, args.content, "utf-8");
        
        return {
          success: true,
          path: args.path,
          absolutePath,
          session: sessionId,
          bytesWritten: args.content.length
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          path: args.path,
          session: args.session
        };
      }
    }
  });

  // Session list directory tool
  commandMapper.addCommand({
    name: "session.list_directory",
    description: "List contents of a directory in the current session workspace with path validation",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .default(".")
        .describe("Relative path to the directory within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
    execute: async (args: { path?: string; session?: string }) => {
      try {
        const sessionId = args.session || await resolver.getCurrentSessionId();
        const directoryPath = args.path || ".";
        const absolutePath = await resolver.resolveSessionPath(sessionId, directoryPath);
        
        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        
        const items = await Promise.all(
          entries.map(async (entry) => {
            const itemPath = resolve(absolutePath, entry.name);
            let size: number | undefined;
            let lastModified: Date | undefined;
            
            try {
              const stats = await fs.stat(itemPath);
              size = stats.size;
              lastModified = stats.mtime;
            } catch {
              // If we can't get stats, continue without them
            }
            
            return {
              name: entry.name,
              type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
              size,
              lastModified: lastModified?.toISOString()
            };
          })
        );
        
        return {
          success: true,
          path: directoryPath,
          absolutePath,
          session: sessionId,
          items
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          path: args.path,
          session: args.session
        };
      }
    }
  });

  // Session file exists tool
  commandMapper.addCommand({
    name: "session.file_exists",
    description: "Check if a file or directory exists in the current session workspace",
    parameters: z.object({
      path: z.string().describe("Relative path to check within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
    execute: async (args: { path: string; session?: string }) => {
      try {
        const sessionId = args.session || await resolver.getCurrentSessionId();
        const absolutePath = await resolver.resolveSessionPath(sessionId, args.path);
        
        try {
          const stats = await fs.stat(absolutePath);
          return {
            success: true,
            exists: true,
            path: args.path,
            absolutePath,
            session: sessionId,
            type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
            size: stats.size,
            lastModified: stats.mtime.toISOString()
          };
        } catch (error: any) {
          if (error.code === "ENOENT") {
            return {
              success: true,
              exists: false,
              path: args.path,
              absolutePath,
              session: sessionId
            };
          }
          throw error;
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          path: args.path,
          session: args.session
        };
      }
    }
  });
}
