export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  lastModified?: Date;
}

export interface WorkspaceOperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Abstract interface for workspace operations
 * Designed to support different backend implementations (local filesystem, containers, etc.)
 */
export interface WorkspaceBackend {
  /**
   * Read file contents from the workspace
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace
   * @returns File contents as string
   */
  readFile(workspaceDir: string, relativePath: string): Promise<string>;

  /**
   * Write content to a file in the workspace
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace
   * @param content Content to write
   * @returns Operation result
   */
  writeFile(workspaceDir: string, relativePath: string, content: string): Promise<WorkspaceOperationResult>;

  /**
   * Delete a file from the workspace
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace
   * @returns Operation result
   */
  deleteFile(workspaceDir: string, relativePath: string): Promise<WorkspaceOperationResult>;

  /**
   * List directory contents
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace (optional, defaults to root)
   * @returns Array of file information
   */
  listDirectory(workspaceDir: string, relativePath?: string): Promise<FileInfo[]>;

  /**
   * Check if a file or directory exists
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace
   * @returns True if exists, false otherwise
   */
  exists(workspaceDir: string, relativePath: string): Promise<boolean>;

  /**
   * Create a directory in the workspace
   * @param workspaceDir Absolute path to the workspace directory
   * @param relativePath Relative path within the workspace
   * @returns Operation result
   */
  createDirectory(workspaceDir: string, relativePath: string): Promise<WorkspaceOperationResult>;
}

/**
 * Error thrown when workspace operations fail
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly workspaceDir: string,
    public readonly relativePath?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Error thrown when a path is invalid or outside workspace boundaries
 */
export class InvalidPathError extends WorkspaceError {
  constructor(
    message: string,
    workspaceDir: string,
    relativePath?: string,
    cause?: Error
  ) {
    super(message, "path_validation", workspaceDir, relativePath, cause);
    this.name = "InvalidPathError";
  }
}

/**
 * Error thrown when a file or directory is not found
 */
export class FileNotFoundError extends WorkspaceError {
  constructor(
    workspaceDir: string,
    relativePath: string,
    cause?: Error
  ) {
    super(
      `File not found: ${relativePath}`,
      "file_not_found",
      workspaceDir,
      relativePath,
      cause
    );
    this.name = "FileNotFoundError";
  }
}

/**
 * Error thrown when attempting to perform an operation on a directory when expecting a file
 */
export class DirectoryError extends WorkspaceError {
  constructor(
    message: string,
    workspaceDir: string,
    relativePath: string,
    cause?: Error
  ) {
    super(message, "directory_operation", workspaceDir, relativePath, cause);
    this.name = "DirectoryError";
  }
} 
