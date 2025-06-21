/**
 * Types and utilities for project context management.
 * This module provides a structured way to handle project-specific context information.
 */

import fs from "fs";
import path from "path";
import { log } from "../utils/logger.js";

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
 * @returns True if the path exists and is a directory, false otherwise
 */
export function validateRepositoryPath(_repositoryPath: string): boolean {
  try {
    // Check if the path exists and is a directory
    return fs.existsSync(repositoryPath) && fs.statSync(repositoryPath).isDirectory();
  } catch (___error) {
    return false;
  }
}

/**
 * Creates a ProjectContext object with validation.
 * @param repositoryPath The repository path to use in the context
 * @returns A ProjectContext object if validation passes
 * @throws Error if the repository path is invalid
 */
export function createProjectContext(_repositoryPath: string): ProjectContext {
  // Normalize the path to handle any relative paths or trailing slashes
  const normalizedPath = path.resolve(repositoryPath);

  // Validate the repository path
  if (!validateRepositoryPath(normalizedPath)) {
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
 * @returns A ProjectContext object using process.cwd() as the repository path
 * @throws Error if the current directory is invalid as a repository path
 */
export function createProjectContextFromCwd(): ProjectContext {
  return createProjectContext(process.cwd());
}
