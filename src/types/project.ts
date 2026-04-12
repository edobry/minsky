/**
 * Types and utilities for project context management.
 * This module provides a structured way to handle project-specific context information.
 */

import path from "path";
import type { SyncFsLike } from "../domain/interfaces/fs-like";
import { createRealSyncFs } from "../domain/interfaces/fs-like";
import { log } from "../utils/logger";

/**
 * ProjectContext represents the context information for a Minsky project.
 * It currently focuses on repository location but is designed for future expansion.
 */
export interface ProjectContext {
  /**
   * The absolute path to the repository root directory.
   * This is used as the default context for operations that require repository information.
   */
  repositoryPath: string;

  /**
   * Additional project-specific context information can be added here in the future.
   * For example, project name, configuration paths, etc.
   */
}

/**
 * Validates that a path exists and can be used as a repository path.
 * @param repositoryPath The path to validate
 * @param deps Optional dependencies for testing
 * @returns True if the path exists and is a directory, false otherwise
 */
export function validateRepositoryPath(
  repositoryPath: string,
  deps?: { fs?: SyncFsLike }
): boolean {
  const fs = deps?.fs ?? createRealSyncFs();
  try {
    // Check if the path exists and is a directory
    return fs.existsSync(repositoryPath) && fs.statSync(repositoryPath).isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Creates a ProjectContext object with validation.
 * @param repositoryPath The repository path to use in the context
 * @param deps Optional dependencies for testing
 * @returns A ProjectContext object if validation passes
 * @throws Error if the repository path is invalid
 */
export function createProjectContext(
  repositoryPath: string,
  deps?: { fs?: SyncFsLike }
): ProjectContext {
  // Normalize the path to handle any relative paths or trailing slashes
  const normalizedPath = path.resolve(repositoryPath);

  // Validate the repository path
  if (!validateRepositoryPath(normalizedPath, deps)) {
    const errorMessage = `Invalid repository path: ${normalizedPath}`;
    log.error(errorMessage);
    throw new Error(errorMessage);
  }

  return {
    repositoryPath: normalizedPath,
  };
}

/**
 * Creates a ProjectContext using the current working directory.
 * @param deps Optional dependencies for testing
 * @returns A ProjectContext object using process.cwd() as the repository path
 * @throws Error if the current directory is invalid as a repository path
 */
export function createProjectContextFromCwd(deps?: { fs?: SyncFsLike }): ProjectContext {
  return createProjectContext(process.cwd(), deps);
}
