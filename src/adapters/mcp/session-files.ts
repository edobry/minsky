/**
 * MCP adapter for session file operations
 * Provides session-scoped file operations that enforce workspace isolation
 */
import { mkdir, stat, rename } from "fs/promises";
import { join, relative, dirname } from "path";
import type { CommandMapper } from "../../mcp/command-mapper";
import { SessionPathResolver } from "../../domain/session/session-path-resolver";
export { SessionPathResolver };
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { ErrorContext } from "../../utils/semantic-error-classifier";
import {
  FileMoveSchema,
  FileRenameSchema,
  FileOperationResponse,
  FileMoveParameters,
  FileRenameParameters,
} from "../../domain/schemas";
import { createSuccessResponse, createErrorResponse } from "../../domain/schemas";

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
  // Session move file tool
  commandMapper.addCommand({
    name: "session.move_file",
    description: "Move a file from one location to another within a session workspace",
    parameters: FileMoveSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      const typedArgs = args as FileMoveParameters;
      try {
        const sourceResolvedPath = await pathResolver.resolvePath(
          typedArgs.sessionId,
          typedArgs.sourcePath
        );
        const targetResolvedPath = await pathResolver.resolvePath(
          typedArgs.sessionId,
          typedArgs.targetPath
        );

        // Validate source file exists
        await pathResolver.validatePathExists(sourceResolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const sourceStats = await stat(sourceResolvedPath);
        if (!sourceStats.isFile()) {
          throw new Error(
            `Source path "${typedArgs.sourcePath}" is not a file - use appropriate directory tools`
          );
        }

        // Check if target already exists and handle overwrite logic
        let targetExists = false;
        try {
          await stat(targetResolvedPath);
          targetExists = true;
        } catch (error) {
          // Target doesn't exist - that's fine
          targetExists = false;
        }

        if (targetExists && !typedArgs.overwrite) {
          throw new Error(
            `Target path "${typedArgs.targetPath}" already exists. Set overwrite: true to replace it.`
          );
        }

        // Create parent directories if requested and they don't exist
        if (typedArgs.createDirs) {
          const parentDir = dirname(targetResolvedPath);
          await mkdir(parentDir, { recursive: true });
        }

        // Perform the atomic move operation
        await rename(sourceResolvedPath, targetResolvedPath);

        log.debug("Session file move successful", {
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          sourceResolvedPath,
          targetResolvedPath,
          overwrite: typedArgs.overwrite,
          createdDirs: typedArgs.createDirs,
        });

        const sourceResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          sourceResolvedPath
        );
        const targetResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          targetResolvedPath
        );

        return createSuccessResponse({
          path: typedArgs.targetPath,
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          sourceResolvedPath: sourceResolvedPath_rel,
          targetResolvedPath: targetResolvedPath_rel,
          moved: true,
          overwritten: targetExists,
        });
      } catch (error) {
        const _errorContext: ErrorContext = {
          operation: "move_file",
          path: `${typedArgs.sourcePath} -> ${typedArgs.targetPath}`,
          session: typedArgs.sessionId,
          createDirs: typedArgs.createDirs,
        };

        log.error("Session file move failed", {
          session: typedArgs.sessionId,
          sourcePath: typedArgs.sourcePath,
          targetPath: typedArgs.targetPath,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), undefined, {
          session: typedArgs.sessionId,
          path: typedArgs.sourcePath,
        });
      }
    },
  });

  // Session rename file tool
  commandMapper.addCommand({
    name: "session.rename_file",
    description: "Rename a file within a session workspace",
    parameters: FileRenameSchema,
    handler: async (args): Promise<FileOperationResponse> => {
      const typedArgs = args as FileRenameParameters;
      try {
        const resolvedPath = await pathResolver.resolvePath(typedArgs.sessionId, typedArgs.path);

        // Validate source file exists
        await pathResolver.validatePathExists(resolvedPath);

        // Additional safety check - ensure source is a file, not a directory
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          throw new Error(
            `Path "${typedArgs.path}" is not a file - use appropriate directory tools`
          );
        }

        // Construct target path by replacing the filename
        const sourceDir = dirname(resolvedPath);
        const targetResolvedPath = join(sourceDir, typedArgs.newName);
        const targetPath = join(dirname(typedArgs.path), typedArgs.newName);

        // Validate that target path is still within session workspace
        await pathResolver.resolvePath(typedArgs.sessionId, targetPath);

        // Check if target already exists and handle overwrite logic
        let targetExists = false;
        try {
          await stat(targetResolvedPath);
          targetExists = true;
        } catch (error) {
          // Target doesn't exist - that's fine
          targetExists = false;
        }

        if (targetExists && !typedArgs.overwrite) {
          throw new Error(
            `Target file "${typedArgs.newName}" already exists in the same directory. Set overwrite: true to replace it.`
          );
        }

        // Perform the atomic rename operation
        await rename(resolvedPath, targetResolvedPath);

        log.debug("Session file rename successful", {
          session: typedArgs.sessionId,
          originalPath: typedArgs.path,
          newName: typedArgs.newName,
          targetPath,
          resolvedPath,
          targetResolvedPath,
          overwrite: typedArgs.overwrite,
        });

        const originalResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          resolvedPath
        );
        const newResolvedPath_rel = relative(
          await pathResolver.getSessionWorkspacePath(typedArgs.sessionId),
          targetResolvedPath
        );

        return createSuccessResponse({
          path: targetPath,
          session: typedArgs.sessionId,
          originalPath: typedArgs.path,
          newPath: targetPath,
          newName: typedArgs.newName,
          originalResolvedPath: originalResolvedPath_rel,
          newResolvedPath: newResolvedPath_rel,
          renamed: true,
          overwritten: targetExists,
        });
      } catch (error) {
        const _errorContext: ErrorContext = {
          operation: "rename_file",
          path: `${typedArgs.path} -> ${typedArgs.newName}`,
          session: typedArgs.sessionId,
        };

        log.error("Session file rename failed", {
          session: typedArgs.sessionId,
          path: typedArgs.path,
          newName: typedArgs.newName,
          error: getErrorMessage(error),
        });

        return createErrorResponse(getErrorMessage(error), undefined, {
          session: typedArgs.sessionId,
          path: typedArgs.path,
        });
      }
    },
  });

  log.debug("Session file operation tools registered successfully");
}
