import { promises as fs } from "fs";
import { join, resolve, relative, dirname } from "path";
import { log } from "../../utils/logger";
import {
  WorkspaceBackend,
  FileInfo,
  WorkspaceOperationResult,
  WorkspaceError,
  InvalidPathError,
  FileNotFoundError,
  DirectoryError,
} from "./workspace-backend";

/**
 * Local filesystem implementation of WorkspaceBackend
 * Provides direct filesystem access for workspace operations
 */
export class LocalWorkspaceBackend implements WorkspaceBackend {
  /**
   * Validate and resolve a path within the workspace
   * Ensures the path is within workspace boundaries and is safe to use
   */
  private validateAndResolvePath(workspaceDir: string, relativePath: string): string {
    // Normalize the workspace directory path
    const normalizedWorkspace = resolve(workspaceDir);
    
    // Resolve the target path
    const targetPath = resolve(normalizedWorkspace, relativePath);
    
    // Check if the resolved path is within the workspace
    const relativeToBoundary = relative(normalizedWorkspace, targetPath);
    
    // If the relative path starts with "..", it's outside the workspace
    if (relativeToBoundary.startsWith("..") || relativeToBoundary === "..") {
      throw new InvalidPathError(
        `Path '${relativePath}' resolves outside workspace boundaries`,
        normalizedWorkspace,
        relativePath
      );
    }
    
    // Log the path resolution for debugging
    log.debug("Resolved workspace path", {
      workspaceDir: normalizedWorkspace,
      relativePath,
      resolvedPath: targetPath,
      relativeToBoundary,
    });
    
    return targetPath;
  }

  /**
   * Get file information for a given path
   */
  private async getFileInfo(fullPath: string, workspaceDir: string): Promise<FileInfo> {
    try {
      const stats = await fs.stat(fullPath);
      const relativePath = relative(workspaceDir, fullPath);
      
      return {
        name: relativePath.split("/").pop() || relativePath,
        path: relativePath,
        type: stats.isDirectory() ? "directory" : "file",
        size: stats.isFile() ? stats.size : undefined,
        lastModified: stats.mtime,
      };
    } catch (error) {
      throw new WorkspaceError(
        `Failed to get file info: ${error instanceof Error ? error.message : String(error)}`,
        "file_info",
        workspaceDir,
        relative(workspaceDir, fullPath),
        error instanceof Error ? error : undefined
      );
    }
  }

  async readFile(workspaceDir: string, relativePath: string): Promise<string> {
    const fullPath = this.validateAndResolvePath(workspaceDir, relativePath);
    
    try {
      // Check if the path exists and is a file
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        throw new DirectoryError(
          `Cannot read directory as file: ${relativePath}`,
          workspaceDir,
          relativePath
        );
      }
      
      const content = (await fs.readFile(fullPath, { encoding: "utf8" })) as string;
      
      log.debug("Read file from workspace", {
        workspaceDir,
        relativePath,
        contentLength: content.length,
      });
      
      return content;
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof DirectoryError) {
        throw error;
      }
      
      // Handle file not found
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new FileNotFoundError(workspaceDir, relativePath, error);
      }
      
      throw new WorkspaceError(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        "read_file",
        workspaceDir,
        relativePath,
        error instanceof Error ? error : undefined
      );
    }
  }

  async writeFile(workspaceDir: string, relativePath: string, content: string): Promise<WorkspaceOperationResult> {
    const fullPath = this.validateAndResolvePath(workspaceDir, relativePath);
    
    try {
      // Ensure the directory exists
      const dir = dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      
      // Write the file atomically by writing to a temp file first
      const tempPath = `${fullPath}.tmp.${Date.now()}`;
      
      try {
        await fs.writeFile(tempPath, content, "utf8");
        await fs.rename(tempPath, fullPath);
        
        log.debug("Wrote file to workspace", {
          workspaceDir,
          relativePath,
          contentLength: content.length,
        });
        
        return {
          success: true,
          message: `File written successfully: ${relativePath}`,
        };
      } catch (error) {
        // Clean up temp file if it exists
        try {
          await fs.unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof InvalidPathError) {
        throw error;
      }
      
      const message = `Failed to write file: ${error instanceof Error ? error.message : String(error)}`;
      log.error("Write file failed", {
        workspaceDir,
        relativePath,
        error: message,
      });
      
      return {
        success: false,
        error: message,
      };
    }
  }

  async deleteFile(workspaceDir: string, relativePath: string): Promise<WorkspaceOperationResult> {
    const fullPath = this.validateAndResolvePath(workspaceDir, relativePath);
    
    try {
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory()) {
        // Delete directory recursively
        await fs.rmdir(fullPath, { recursive: true });
        log.debug("Deleted directory from workspace", {
          workspaceDir,
          relativePath,
        });
      } else {
        // Delete file
        await fs.unlink(fullPath);
        log.debug("Deleted file from workspace", {
          workspaceDir,
          relativePath,
        });
      }
      
      return {
        success: true,
        message: `${stats.isDirectory() ? "Directory" : "File"} deleted successfully: ${relativePath}`,
      };
    } catch (error) {
      if (error instanceof InvalidPathError) {
        throw error;
      }
      
      // Handle file not found
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new FileNotFoundError(workspaceDir, relativePath, error);
      }
      
      const message = `Failed to delete: ${error instanceof Error ? error.message : String(error)}`;
      log.error("Delete failed", {
        workspaceDir,
        relativePath,
        error: message,
      });
      
      return {
        success: false,
        error: message,
      };
    }
  }

  async listDirectory(workspaceDir: string, relativePath?: string): Promise<FileInfo[]> {
    const fullPath = this.validateAndResolvePath(workspaceDir, relativePath || ".");
    
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isDirectory()) {
        throw new DirectoryError(
          `Cannot list non-directory: ${relativePath || "."}`,
          workspaceDir,
          relativePath || "."
        );
      }
      
      const entries = await fs.readdir(fullPath);
      const fileInfos: FileInfo[] = [];
      
      for (const entry of entries) {
        const entryPath = join(fullPath, entry);
        try {
          const fileInfo = await this.getFileInfo(entryPath, workspaceDir);
          fileInfos.push(fileInfo);
        } catch (error) {
          // Log but don't fail on individual file errors
          log.warn("Failed to get info for directory entry", {
            entry,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      
      log.debug("Listed directory contents", {
        workspaceDir,
        relativePath: relativePath || ".",
        entryCount: fileInfos.length,
      });
      
      return fileInfos.sort((a, b) => {
        // Sort directories first, then files, then alphabetically
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof DirectoryError) {
        throw error;
      }
      
      // Handle directory not found
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new FileNotFoundError(workspaceDir, relativePath || ".", error);
      }
      
      throw new WorkspaceError(
        `Failed to list directory: ${error instanceof Error ? error.message : String(error)}`,
        "list_directory",
        workspaceDir,
        relativePath,
        error instanceof Error ? error : undefined
      );
    }
  }

  async exists(workspaceDir: string, relativePath: string): Promise<boolean> {
    try {
      const fullPath = this.validateAndResolvePath(workspaceDir, relativePath);
      await fs.access(fullPath);
      return true;
    } catch (error) {
      if (error instanceof InvalidPathError) {
        throw error;
      }
      return false;
    }
  }

  async createDirectory(workspaceDir: string, relativePath: string): Promise<WorkspaceOperationResult> {
    const fullPath = this.validateAndResolvePath(workspaceDir, relativePath);
    
    try {
      await fs.mkdir(fullPath, { recursive: true });
      
      log.debug("Created directory in workspace", {
        workspaceDir,
        relativePath,
      });
      
      return {
        success: true,
        message: `Directory created successfully: ${relativePath}`,
      };
    } catch (error) {
      if (error instanceof InvalidPathError) {
        throw error;
      }
      
      const message = `Failed to create directory: ${error instanceof Error ? error.message : String(error)}`;
      log.error("Create directory failed", {
        workspaceDir,
        relativePath,
        error: message,
      });
      
      return {
        success: false,
        error: message,
      };
    }
  }
} 
