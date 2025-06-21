import { z } from "zod";
import { CommandMapper } from "../../mcp/command-mapper";
import { SessionWorkspaceService } from "../../domain/session/session-workspace-service";
import { SessionDB } from "../../domain/session";
import { SessionNotFoundError } from "../../domain/session/session-path-resolver";
import { InvalidPathError, FileNotFoundError, DirectoryError } from "../../domain/workspace/workspace-backend";
import { log } from "../../utils/logger";

/**
 * Session file operation schemas for MCP tools
 */
const sessionFileBaseSchema = z.object({
  session: z.string().describe("Session identifier (session name, task ID like '049' or '#049')"),
});

const sessionReadFileSchema = sessionFileBaseSchema.extend({
  path: z.string().describe("Relative path to the file within the session workspace"),
});

const sessionWriteFileSchema = sessionFileBaseSchema.extend({
  path: z.string().describe("Relative path to the file within the session workspace"),
  content: z.string().describe("Content to write to the file"),
});

const sessionDeleteFileSchema = sessionFileBaseSchema.extend({
  path: z.string().describe("Relative path to the file or directory within the session workspace"),
});

const sessionListDirSchema = sessionFileBaseSchema.extend({
  path: z.string().optional().describe("Relative path to the directory within the session workspace (optional, defaults to root)"),
});

const sessionExistsSchema = sessionFileBaseSchema.extend({
  path: z.string().describe("Relative path to check within the session workspace"),
});

const sessionCreateDirSchema = sessionFileBaseSchema.extend({
  path: z.string().describe("Relative path to the directory to create within the session workspace"),
});

const sessionInfoSchema = sessionFileBaseSchema;

/**
 * Register session-aware file operation tools with the MCP server
 * @param commandMapper The CommandMapper instance to register tools with
 */
export function registerSessionFileTools(commandMapper: CommandMapper): void {
  // Create session workspace service with default session provider
  const sessionWorkspaceService = new SessionWorkspaceService(new SessionDB());

  /**
   * Helper function to handle common error cases
   */
  const handleError = (error: unknown, operation: string, sessionId: string, path?: string) => {
    if (error instanceof SessionNotFoundError) {
      return {
        success: false,
        error: `Session not found: ${sessionId}. Please check the session identifier.`,
        errorType: "session_not_found",
      };
    }
    
    if (error instanceof InvalidPathError) {
      return {
        success: false,
        error: `Invalid path: ${error.message}`,
        errorType: "invalid_path",
      };
    }
    
    if (error instanceof FileNotFoundError) {
      return {
        success: false,
        error: `File not found: ${path}`,
        errorType: "file_not_found",
      };
    }
    
    if (error instanceof DirectoryError) {
      return {
        success: false,
        error: `Directory operation error: ${error.message}`,
        errorType: "directory_error",
      };
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`Session file operation failed: ${operation}`, {
      sessionId,
      path,
      error: errorMessage,
    });
    
    return {
      success: false,
      error: `Operation failed: ${errorMessage}`,
      errorType: "unknown_error",
    };
  };

  // Register session_read_file tool
  commandMapper.addCommand({
    name: "session_read_file",
    description: "Read file contents from a session workspace. Ensures files can only be read from within the specified session boundaries.",
    parameters: sessionReadFileSchema,
    execute: async (args) => {
      try {
        const content = await sessionWorkspaceService.readFile(args.session, args.path);
        
        return {
          success: true,
          content,
          session: args.session,
          path: args.path,
          size: content.length,
        };
      } catch (error) {
        return handleError(error, "read_file", args.session, args.path);
      }
    },
  });

  // Register session_write_file tool
  commandMapper.addCommand({
    name: "session_write_file",
    description: "Write content to a file in a session workspace. Creates directories as needed and ensures files are only written within session boundaries.",
    parameters: sessionWriteFileSchema,
    execute: async (args) => {
      try {
        const result = await sessionWorkspaceService.writeFile(args.session, args.path, args.content);
        
        return {
          success: result.success,
          message: result.message,
          error: result.error,
          session: args.session,
          path: args.path,
          contentLength: args.content.length,
        };
      } catch (error) {
        return handleError(error, "write_file", args.session, args.path);
      }
    },
  });

  // Register session_delete_file tool
  commandMapper.addCommand({
    name: "session_delete_file",
    description: "Delete a file or directory from a session workspace. Handles both files and directories recursively.",
    parameters: sessionDeleteFileSchema,
    execute: async (args) => {
      try {
        const result = await sessionWorkspaceService.deleteFile(args.session, args.path);
        
        return {
          success: result.success,
          message: result.message,
          error: result.error,
          session: args.session,
          path: args.path,
        };
      } catch (error) {
        return handleError(error, "delete_file", args.session, args.path);
      }
    },
  });

  // Register session_list_dir tool
  commandMapper.addCommand({
    name: "session_list_dir",
    description: "List contents of a directory in a session workspace. Returns file and directory information with metadata.",
    parameters: sessionListDirSchema,
    execute: async (args) => {
      try {
        const files = await sessionWorkspaceService.listDirectory(args.session, args.path);
        
        return {
          success: true,
          files: files.map(file => ({
            name: file.name,
            path: file.path,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified?.toISOString(),
          })),
          session: args.session,
          directory: args.path || ".",
          count: files.length,
        };
      } catch (error) {
        return handleError(error, "list_dir", args.session, args.path);
      }
    },
  });

  // Register session_exists tool
  commandMapper.addCommand({
    name: "session_exists",
    description: "Check if a file or directory exists in a session workspace.",
    parameters: sessionExistsSchema,
    execute: async (args) => {
      try {
        const exists = await sessionWorkspaceService.exists(args.session, args.path);
        
        return {
          success: true,
          exists,
          session: args.session,
          path: args.path,
        };
      } catch (error) {
        return handleError(error, "exists", args.session, args.path);
      }
    },
  });

  // Register session_create_dir tool
  commandMapper.addCommand({
    name: "session_create_dir",
    description: "Create a directory in a session workspace. Creates parent directories as needed.",
    parameters: sessionCreateDirSchema,
    execute: async (args) => {
      try {
        const result = await sessionWorkspaceService.createDirectory(args.session, args.path);
        
        return {
          success: result.success,
          message: result.message,
          error: result.error,
          session: args.session,
          path: args.path,
        };
      } catch (error) {
        return handleError(error, "create_dir", args.session, args.path);
      }
    },
  });

  // Register session_info tool
  commandMapper.addCommand({
    name: "session_info",
    description: "Get information about a session workspace, including session details and workspace directory path.",
    parameters: sessionInfoSchema,
    execute: async (args) => {
      try {
        const info = await sessionWorkspaceService.getWorkspaceInfo(args.session);
        
        return {
          success: true,
          sessionInfo: {
            sessionId: info.sessionId,
            sessionName: info.sessionName,
            workspaceDir: info.workspaceDir,
            taskId: info.taskId,
          },
        };
      } catch (error) {
        return handleError(error, "session_info", args.session);
      }
    },
  });

  log.debug("Registered session file tools", {
    tools: [
      "session_read_file",
      "session_write_file", 
      "session_delete_file",
      "session_list_dir",
      "session_exists",
      "session_create_dir",
      "session_info",
    ],
  });
} 
