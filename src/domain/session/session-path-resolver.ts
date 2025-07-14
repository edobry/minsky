import { resolve, relative, join, normalize } from "path";
import { log } from "../../utils/logger";
import { InvalidPathError } from "../workspace/workspace-backend";
import { getErrorMessage } from "../../errors/index";

/**
 * Error thrown when a session is not found or invalid
 */
export class SessionNotFoundError extends Error {
  constructor(
    public readonly sessionId: string,
    message?: string
  ) {
    super(message || `Session not found: ${sessionId}`);
    this?.name = "SessionNotFoundError";
  }
}

/**
 * Provides session-aware path resolution and validation
 * Ensures all paths are within session workspace boundaries
 */
export class SessionPathResolver {
  /**
   * Validate that a path is within session boundaries
   * @param sessionDir Absolute path to the session workspace
   * @param userPath User-provided path (relative or absolute)
   * @returns Normalized absolute path within session boundaries
   * @throws InvalidPathError if path is outside session boundaries
   */
  validateAndResolvePath(sessionDir: string, userPath: string): string {
    // Normalize the session directory path
    const normalizedSessionDir = resolve(sessionDir);
    
    // Handle different path formats
    let targetPath: string;
    
    if (userPath.startsWith("/")) {
      // Absolute path - could be dangerous, check if it's within session
      targetPath = resolve(userPath);
    } else {
      // Relative path - resolve relative to session directory
      targetPath = resolve(normalizedSessionDir, userPath);
    }
    
    // Normalize the target path to handle any "../" segments
    targetPath = normalize(targetPath);
    
    // Check if the resolved path is within the session workspace
    const relativeToBoundary = relative(normalizedSessionDir, targetPath);
    
    // If the relative path starts with "..", it's outside the session
    if (relativeToBoundary.startsWith("..") || relativeToBoundary === "..") {
      throw new InvalidPathError(
        `Path '${userPath}' resolves outside session workspace boundaries. Resolved to: ${targetPath}`,
        normalizedSessionDir,
        userPath
      );
    }
    
    log.debug("Validated session path", {
      sessionDir: normalizedSessionDir,
      userPath,
      resolvedPath: targetPath,
      relativeToBoundary,
    });
    
    return targetPath;
  }

  /**
   * Check if a resolved path is within session boundaries
   * @param sessionDir Absolute path to the session workspace
   * @param resolvedPath Absolute path to check
   * @returns True if path is within boundaries, false otherwise
   */
  isPathWithinSession(sessionDir: string, resolvedPath: string): boolean {
    try {
      const normalizedSessionDir = resolve(sessionDir);
      const normalizedResolvedPath = resolve(resolvedPath);
      const relativePath = relative(normalizedSessionDir, normalizedResolvedPath);
      
      // Path is within session if it doesn't start with ".."
      return !relativePath.startsWith("..") && relativePath !== "..";
    } catch (error) {
      log.warn("Error checking path boundaries", {
        sessionDir,
        resolvedPath,
        error: getErrorMessage(error as any),
      });
      return false;
    }
  }

  /**
   * Convert an absolute path to a relative path within the session
   * @param sessionDir Absolute path to the session workspace
   * @param absolutePath Absolute path to convert
   * @returns Relative path within session, or null if outside boundaries
   */
  absoluteToRelative(sessionDir: string, absolutePath: string): string | null {
    try {
      const normalizedSessionDir = resolve(sessionDir);
      const normalizedAbsolutePath = resolve(absolutePath);
      const relativePath = relative(normalizedSessionDir, normalizedAbsolutePath);
      
      // Return null if path is outside session boundaries
      if (relativePath.startsWith("..") || relativePath === "..") {
        return null;
      }
      
      // Return "." for the session root
      return relativePath || ".";
    } catch (error) {
      log.warn("Error converting absolute to relative path", {
        sessionDir,
        absolutePath,
        error: getErrorMessage(error as any),
      });
      return null;
    }
  }

  /**
   * Normalize a relative path to prevent directory traversal
   * @param basePath Base path to resolve against
   * @param relativePath Relative path to normalize
   * @returns Normalized relative path
   */
  normalizeRelativePath(basePath: string, relativePath: string): string {
    const resolved = resolve(basePath, relativePath);
    const normalizedRelative = relative(basePath, resolved);
    
    // Ensure we don't allow paths that go outside the base
    if (normalizedRelative.startsWith("..")) {
      throw new InvalidPathError(
        `Relative path '${relativePath}' attempts to traverse outside base directory`,
        basePath,
        relativePath
      );
    }
    
    return normalizedRelative;
  }

  /**
   * Validate multiple paths at once
   * @param sessionDir Absolute path to the session workspace
   * @param userPaths Array of user-provided paths
   * @returns Array of validated absolute paths
   * @throws InvalidPathError if any path is invalid
   */
  validateMultiplePaths(sessionDir: string, userPaths: string[]): string[] {
    const validatedPaths: string[] = [];
    const errors: string[] = [];
    
    for (const userPath of userPaths) {
      try {
        const validatedPath = this.validateAndResolvePath(sessionDir, userPath);
        validatedPaths.push(validatedPath);
      } catch (error) {
        if (error instanceof InvalidPathError) {
          errors.push(`${userPath}: ${(error as any).message}`);
        } else {
          errors.push(`${userPath}: Unexpected error during validation`);
        }
      }
    }
    
    if (errors?.length > 0) {
      throw new InvalidPathError(
        `Multiple path validation errors:\n${errors.join("\n")}`,
        sessionDir
      );
    }
    
    return validatedPaths;
  }

  /**
   * Create a safe path within the session by joining components
   * @param sessionDir Absolute path to the session workspace
   * @param pathComponents Path components to join
   * @returns Safe absolute path within session boundaries
   */
  createSafePath(sessionDir: string, ...pathComponents: string[]): string {
    const relativePath = join(...pathComponents);
    return this.validateAndResolvePath(sessionDir, relativePath);
  }

  /**
   * Get the relative path from session root
   * Useful for display purposes and API responses
   * @param sessionDir Absolute path to the session workspace
   * @param userPath User-provided path
   * @returns Relative path from session root
   */
  getRelativePathFromSession(sessionDir: string, userPath: string): string {
    const absolutePath = this.validateAndResolvePath(sessionDir, userPath);
    const relativePath = relative(sessionDir, absolutePath);
    return relativePath || ".";
  }
} 
