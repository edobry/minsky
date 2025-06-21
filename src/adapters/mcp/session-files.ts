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
class SessionPathResolver {
  private sessionDb: SessionDB;

  constructor(sessionDb: SessionDB = new SessionDB()) {
    this.sessionDb = sessionDb;
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
    const currentSession = await getCurrentSession();
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
export function registerSessionFileTools(commandMapper: CommandMapper): void {
  const pathResolver = new SessionPathResolver();

  // Register session file tools (using simplified CommandMapper interface)
  commandMapper.addCommand({
    name: "session.read_file",
    description: "Read a file from the current session workspace with path validation",
    inputSchema: z.object({
      path: z.string().describe("Relative path to the file within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
  });

  commandMapper.addCommand({
    name: "session.write_file",
    description: "Write content to a file in the current session workspace with path validation",
    inputSchema: z.object({
      path: z.string().describe("Relative path to the file within the session workspace"),
      content: z.string().describe("Content to write to the file"),
      createDirectories: z
        .boolean()
        .optional()
        .default(true)
        .describe("Create parent directories if they don't exist"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
  });

  commandMapper.addCommand({
    name: "session.list_directory",
    description:
      "List contents of a directory in the current session workspace with path validation",
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .default(".")
        .describe("Relative path to the directory within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
  });

  commandMapper.addCommand({
    name: "session.file_exists",
    description: "Check if a file or directory exists in the current session workspace",
    inputSchema: z.object({
      path: z.string().describe("Relative path to check within the session workspace"),
      session: z.string().optional().describe("Session ID (optional, defaults to current session)"),
    }),
  });
}
