import { createSessionProvider, type SessionProviderInterface } from "../session";
import { SessionPathResolver, SessionNotFoundError } from "./session-path-resolver";
import {
  WorkspaceBackend,
  FileInfo,
  WorkspaceOperationResult,
} from "../workspace/workspace-backend";
import { LocalWorkspaceBackend } from "../workspace/local-workspace-backend";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

export interface SessionWorkspaceInfo {
  sessionId: string;
  sessionName: string;
  workspaceDir: string;
  taskId?: string;
}

/**
 * Service for session-aware workspace operations
 * Bridges session management with workspace backend operations
 */
export class SessionWorkspaceService {
  private sessionProvider: SessionProviderInterface;
  private pathResolver: SessionPathResolver;
  private workspaceBackend: WorkspaceBackend;

  constructor(sessionProvider: SessionProviderInterface, workspaceBackend?: WorkspaceBackend) {
    this.sessionProvider = sessionProvider;
    this.pathResolver = new SessionPathResolver();
    this.workspaceBackend = workspaceBackend || new LocalWorkspaceBackend();
  }

  /**
   * Get session workspace information
   * @param sessionId Session identifier (can be session name, task ID, etc.)
   * @returns Session workspace information
   * @throws SessionNotFoundError if session doesn't exist
   */
  async getSessionWorkspace(sessionId: string): Promise<SessionWorkspaceInfo> {
    try {
      // Try to get session by name first
      let session = await (this.sessionProvider as unknown).getSession(sessionId);

      if (!session) {
        // If not found by name, try to find by task ID
        const sessions = await (this.sessionProvider as unknown).listSessions();
        session =
          (sessions as unknown).find((s) => (s as unknown).taskId === sessionId || (s as unknown).taskId === `#${sessionId}`) || null;

        if (!session) {
          throw new SessionNotFoundError(sessionId, `Session not found: ${sessionId}`);
        }
      }

      // Get the session directory from the session provider
      const sessionDir = await (this.sessionProvider as unknown).getSessionWorkdir((session as unknown).session);

      if (!sessionDir) {
        throw new SessionNotFoundError(
          sessionId,
          `Session directory not found for session: ${(session as unknown).session}`
        );
      }

      log.debug("Retrieved session workspace info", {
        sessionId,
        sessionName: (session as unknown).session,
        workspaceDir: sessionDir,
        taskId: (session as unknown).taskId,
      });

      return {
        sessionId,
        sessionName: (session as unknown).session,
        workspaceDir: sessionDir,
        taskId: (session as unknown).taskId,
      };
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw error;
      }

      log.error("Failed to get session workspace", {
        sessionId,
        error: getErrorMessage(error as any),
      });

      throw new SessionNotFoundError(
        sessionId,
        `Failed to get session workspace: ${getErrorMessage(error as any)}`
      );
    }
  }

  /**
   * Read a file from a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @returns File contents
   */
  async readFile(sessionId: string, relativePath: string): Promise<string> {
    const workspace = await this.getSessionWorkspace(sessionId);
    const validatedPath = (this.pathResolver as unknown).getRelativePathFromSession(
      (workspace as unknown).workspaceDir,
      relativePath
    );

    log.debug("Reading file from session workspace", {
      sessionId,
      sessionName: (workspace as unknown).sessionName,
      relativePath,
      validatedPath,
    });

    return (this.workspaceBackend as unknown).readFile((workspace as unknown).workspaceDir, validatedPath);
  }

  /**
   * Write a file to a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @param content File content to write
   * @returns Operation result
   */
  async writeFile(
    sessionId: string,
    relativePath: string,
    content: string
  ): Promise<WorkspaceOperationResult> {
    const workspace = await this.getSessionWorkspace(sessionId);
    const validatedPath = (this.pathResolver as unknown).getRelativePathFromSession(
      (workspace as unknown).workspaceDir,
      relativePath
    );

    log.debug("Writing file to session workspace", {
      sessionId,
      sessionName: (workspace as unknown).sessionName,
      relativePath,
      validatedPath,
      contentLength: (content as unknown).length,
    });

    return (this.workspaceBackend as unknown).writeFile((workspace as unknown).workspaceDir, validatedPath, content);
  }

  /**
   * Delete a file from a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @returns Operation result
   */
  async deleteFile(sessionId: string, relativePath: string): Promise<WorkspaceOperationResult> {
    const workspace = await this.getSessionWorkspace(sessionId);
    const validatedPath = (this.pathResolver as unknown).getRelativePathFromSession(
      (workspace as unknown).workspaceDir,
      relativePath
    );

    log.debug("Deleting file from session workspace", {
      sessionId,
      sessionName: (workspace as unknown).sessionName,
      relativePath,
      validatedPath,
    });

    return (this.workspaceBackend as unknown).deleteFile((workspace as unknown).workspaceDir, validatedPath);
  }

  /**
   * List directory contents in a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace (optional, defaults to root)
   * @returns Array of file information
   */
  async listDirectory(sessionId: string, relativePath?: string): Promise<FileInfo[]> {
    const workspace = await this.getSessionWorkspace(sessionId);
    const validatedPath = relativePath
      ? (this.pathResolver as unknown).getRelativePathFromSession((workspace as unknown).workspaceDir, relativePath)
      : undefined as unknown;

    log.debug("Listing directory in session workspace", {
      sessionId,
      sessionName: (workspace as unknown).sessionName,
      relativePath,
      validatedPath,
    });

    return (this.workspaceBackend as unknown).listDirectory((workspace as unknown).workspaceDir, validatedPath);
  }

  /**
   * Check if a file exists in a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @returns True if file exists, false otherwise
   */
  async exists(sessionId: string, relativePath: string): Promise<boolean> {
    try {
      const workspace = await this.getSessionWorkspace(sessionId);
      const validatedPath = (this.pathResolver as unknown).getRelativePathFromSession(
        (workspace as unknown).workspaceDir,
        relativePath
      );

      return (this.workspaceBackend as unknown).exists((workspace as unknown).workspaceDir, validatedPath);
    } catch (error) {
      log.debug("File existence check failed", {
        sessionId,
        relativePath,
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }

  /**
   * Create a directory in a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @returns Operation result
   */
  async createDirectory(
    sessionId: string,
    relativePath: string
  ): Promise<WorkspaceOperationResult> {
    const workspace = await this.getSessionWorkspace(sessionId);
    const validatedPath = (this.pathResolver as unknown).getRelativePathFromSession(
      (workspace as unknown).workspaceDir,
      relativePath
    );

    log.debug("Creating directory in session workspace", {
      sessionId,
      sessionName: (workspace as unknown).sessionName,
      relativePath,
      validatedPath,
    });

    return (this.workspaceBackend as unknown).createDirectory((workspace as unknown).workspaceDir, validatedPath);
  }

  /**
   * Get workspace information for a session (useful for debugging and info commands)
   * @param sessionId Session identifier
   * @returns Session workspace information
   */
  async getWorkspaceInfo(sessionId: string): Promise<SessionWorkspaceInfo> {
    return this.getSessionWorkspace(sessionId);
  }

  /**
   * Validate that a path is safe within a session workspace
   * @param sessionId Session identifier
   * @param relativePath Relative path to validate
   * @returns True if path is valid and safe
   */
  async validatePath(sessionId: string, relativePath: string): Promise<boolean> {
    try {
      const workspace = await this.getSessionWorkspace(sessionId);
      (this.pathResolver as unknown).validateAndResolvePath((workspace as unknown).workspaceDir, relativePath);
      return true;
    } catch (error) {
      log.debug("Path validation failed", {
        sessionId,
        relativePath,
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }

  /**
   * Get the absolute path for a relative path within a session workspace
   * Useful for debugging and advanced operations
   * @param sessionId Session identifier
   * @param relativePath Relative path within the session workspace
   * @returns Absolute path
   */
  async getAbsolutePath(sessionId: string, relativePath: string): Promise<string> {
    const workspace = await this.getSessionWorkspace(sessionId);
    return (this.pathResolver as unknown).validateAndResolvePath((workspace as unknown).workspaceDir, relativePath);
  }
}
