/**
 * Enhanced mocking utilities with improved isolation and state management.
 * 
 * This module provides advanced mocking capabilities including:
 * - Isolated mock filesystem with automatic state reset
 * - Enhanced module mocking with dependency tracking
 * - Automatic mock validation and cleanup
 * - Cross-test contamination prevention
 * 
 * @module enhanced-mocking
 */

import { mock, afterEach } from "bun:test";
import { log } from "../logger";
import { cleanupManager } from "./cleanup";

interface MockFileSystemState {
  files: Map<string, string>;
  directories: Set<string>;
  metadata: Map<string, { mtime: Date; size: number; mode: number }>;
  isolated: boolean;
  testId: string;
}

interface MockModuleState {
  modulePath: string;
  originalModule?: any;
  mockImplementation: any;
  isActive: boolean;
  testId: string;
}

/**
 * Enhanced mock filesystem with improved isolation
 */
export class EnhancedMockFileSystem {
  private state: MockFileSystemState;
  public static activeInstances: Map<string, EnhancedMockFileSystem> = new Map();

  constructor(initialFiles: Record<string, string> = {}, testId?: string) {
    this.state = {
      files: new Map(),
      directories: new Set(),
      metadata: new Map(),
      isolated: true,
      testId: testId || `test-${Date.now()}-${Math.random().toString(36).substring(7)}`
    };

    // Initialize with provided files
    for (const [path, content] of Object.entries(initialFiles)) {
      this.writeFile(path, content);
    }

    // Register this instance
    EnhancedMockFileSystem.activeInstances.set(this.state.testId, this);

    // Register for cleanup
    cleanupManager.registerCleanupFunction(() => this.cleanup());
  }

  /**
   * Write a file to the mock filesystem
   */
  writeFile(filePath: string, content: string): void {
    this.state.files.set(filePath, content);
    this.state.metadata.set(filePath, {
      mtime: new Date(),
      size: content.length,
      mode: 0o644
    });

    // Ensure parent directories exist
    const parentDir = this.getParentDirectory(filePath);
    if (parentDir) {
      this.ensureDirectory(parentDir);
    }
  }

  /**
   * Read a file from the mock filesystem
   */
  readFile(filePath: string): string {
    if (!this.state.files.has(filePath)) {
      throw new Error(`ENOENT: no such file or directory, open "${filePath}"`);
    }
    return this.state.files.get(filePath)!;
  }

  /**
   * Check if a file or directory exists
   */
  exists(itemPath: string): boolean {
    return this.state.files.has(itemPath) || this.state.directories.has(itemPath);
  }

  /**
   * Create a directory in the mock filesystem
   */
  mkdir(dirPath: string, options?: { recursive?: boolean }): void {
    if (options?.recursive) {
      this.ensureDirectory(dirPath);
    } else {
      const parentDir = this.getParentDirectory(dirPath);
      if (parentDir && !this.state.directories.has(parentDir)) {
        throw new Error(`ENOENT: no such file or directory, mkdir "${dirPath}"`);
      }
      this.state.directories.add(dirPath);
    }
  }

  /**
   * Remove a file or directory
   */
  remove(itemPath: string, options?: { recursive?: boolean; force?: boolean }): void {
    if (this.state.files.has(itemPath)) {
      this.state.files.delete(itemPath);
      this.state.metadata.delete(itemPath);
    } else if (this.state.directories.has(itemPath)) {
      if (options?.recursive) {
        // Remove all files and subdirectories within this directory
        const toRemove = Array.from(this.state.files.keys())
          .concat(Array.from(this.state.directories))
          .filter(path => path.startsWith(`${itemPath}/`));
        
        for (const path of toRemove) {
          this.state.files.delete(path);
          this.state.directories.delete(path);
          this.state.metadata.delete(path);
        }
      }
      this.state.directories.delete(itemPath);
    } else if (!options?.force) {
      throw new Error(`ENOENT: no such file or directory, unlink "${itemPath}"`);
    }
  }

  /**
   * List directory contents
   */
  readdir(dirPath: string): string[] {
    if (!this.state.directories.has(dirPath)) {
      throw new Error(`ENOTDIR: not a directory, scandir "${dirPath}"`);
    }

    const contents = new Set<string>();
    const searchPrefix = dirPath === "/" ? "" : `${dirPath}/`;

    // Find files and directories directly under this path
    for (const filePath of this.state.files.keys()) {
      if (filePath.startsWith(searchPrefix)) {
        const relativePath = filePath.substring(searchPrefix.length);
        const firstSegment = relativePath.split("/")[0];
        if (firstSegment) {
          contents.add(firstSegment);
        }
      }
    }

    for (const dirPath of this.state.directories) {
      if (dirPath.startsWith(searchPrefix)) {
        const relativePath = dirPath.substring(searchPrefix.length);
        const firstSegment = relativePath.split("/")[0];
        if (firstSegment) {
          contents.add(firstSegment);
        }
      }
    }

    return Array.from(contents).sort();
  }

  /**
   * Get file/directory stats
   */
  stat(itemPath: string): { isFile: () => boolean; isDirectory: () => boolean; mtime: Date; size: number; mode: number } {
    if (this.state.files.has(itemPath)) {
      const metadata = this.state.metadata.get(itemPath) || { mtime: new Date(), size: 0, mode: 0o644 };
      return {
        isFile: () => true,
        isDirectory: () => false,
        ...metadata
      };
    } else if (this.state.directories.has(itemPath)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        mtime: new Date(),
        size: 0,
        mode: 0o755
      };
    } else {
      throw new Error(`ENOENT: no such file or directory, stat "${itemPath}"`);
    }
  }

  /**
   * Create comprehensive mock implementations for fs modules
   */
  createFSMocks(): {
    fs: any;
    fsPromises: any;
    } {
    const fsMock = {
      existsSync: (path: string) => this.exists(path),
      readFileSync: (path: string, encoding?: string) => {
        const content = this.readFile(path);
        return encoding === "utf8" || encoding === "utf-8" ? content : Buffer.from(content);
      },
      writeFileSync: (path: string, data: string | Buffer) => {
        this.writeFile(path, typeof data === "string" ? data : data.toString());
      },
      mkdirSync: (path: string, options?: any) => {
        this.mkdir(path, options);
      },
      rmSync: (path: string, options?: any) => {
        this.remove(path, options);
      },
      unlinkSync: (path: string) => {
        this.remove(path);
      },
      readdirSync: (path: string) => this.readdir(path),
      statSync: (path: string) => this.stat(path),
      lstatSync: (path: string) => this.stat(path)
    };

    const fsPromisesMock = {
      readFile: async (path: string, encoding?: string) => {
        const content = this.readFile(path);
        return encoding === "utf8" || encoding === "utf-8" ? content : Buffer.from(content);
      },
      writeFile: async (path: string, data: string | Buffer) => {
        this.writeFile(path, typeof data === "string" ? data : data.toString());
      },
      mkdir: async (path: string, options?: any) => {
        this.mkdir(path, options);
      },
      rm: async (path: string, options?: any) => {
        this.remove(path, options);
      },
      unlink: async (path: string) => {
        this.remove(path);
      },
      readdir: async (path: string) => this.readdir(path),
      stat: async (path: string) => this.stat(path),
      lstat: async (path: string) => this.stat(path),
      access: async (path: string) => {
        if (!this.exists(path)) {
          throw new Error(`ENOENT: no such file or directory, access "${path}"`);
        }
      }
    };

    return { fs: fsMock, fsPromises: fsPromisesMock };
  }

  /**
   * Validate filesystem state for consistency
   */
  validateState(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for orphaned files (files without parent directories)
    for (const filePath of this.state.files.keys()) {
      const parentDir = this.getParentDirectory(filePath);
      if (parentDir && !this.state.directories.has(parentDir)) {
        errors.push(`Orphaned file: ${filePath} (parent directory ${parentDir} does not exist)`);
      }
    }

    // Check for metadata consistency
    for (const filePath of this.state.files.keys()) {
      if (!this.state.metadata.has(filePath)) {
        errors.push(`Missing metadata for file: ${filePath}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Reset the filesystem state
   */
  reset(): void {
    this.state.files.clear();
    this.state.directories.clear();
    this.state.metadata.clear();
  }

  /**
   * Cleanup and unregister this instance
   */
  cleanup(): void {
    this.reset();
    EnhancedMockFileSystem.activeInstances.delete(this.state.testId);
  }

  /**
   * Get current state summary
   */
  getStateSummary(): { fileCount: number; directoryCount: number; testId: string } {
    return {
      fileCount: this.state.files.size,
      directoryCount: this.state.directories.size,
      testId: this.state.testId
    };
  }

  private getParentDirectory(filePath: string): string | null {
    const lastSlash = filePath.lastIndexOf("/");
    return lastSlash > 0 ? filePath.substring(0, lastSlash) : null;
  }

  private ensureDirectory(dirPath: string): void {
    const parts = dirPath.split("/").filter(part => part.length > 0);
    let currentPath = "";

    for (const part of parts) {
      currentPath = `${currentPath}/${part}`;
      if (!this.state.directories.has(currentPath)) {
        this.state.directories.add(currentPath);
      }
    }
  }

  /**
   * Static method to cleanup all active instances
   */
  static cleanupAll(): void {
    for (const instance of EnhancedMockFileSystem.activeInstances.values()) {
      instance.cleanup();
    }
    EnhancedMockFileSystem.activeInstances.clear();
  }
}

/**
 * Enhanced module mocking with dependency tracking
 */
export class EnhancedModuleMocker {
  private static activeModules: Map<string, MockModuleState> = new Map();
  private static isSetup = false;

  /**
   * Setup automatic module mock cleanup
   */
  static setupAutoCleanup(): void {
    if (EnhancedModuleMocker.isSetup) return;

    afterEach(() => {
      EnhancedModuleMocker.resetAllMocks();
    });

    EnhancedModuleMocker.isSetup = true;
  }

  /**
   * Mock a module with enhanced tracking
   */
  static mockModule<T = any>(modulePath: string, mockImplementation: () => T, testId?: string): void {
    const id = testId || `test-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Store original module if not already stored
    if (!EnhancedModuleMocker.activeModules.has(modulePath)) {
      try {
        const originalModule = require(modulePath);
        EnhancedModuleMocker.activeModules.set(modulePath, {
          modulePath,
          originalModule,
          mockImplementation: mockImplementation(),
          isActive: true,
          testId: id
        });
      } catch (error) {
        // Module might not exist yet, that's okay
        EnhancedModuleMocker.activeModules.set(modulePath, {
          modulePath,
          mockImplementation: mockImplementation(),
          isActive: true,
          testId: id
        });
      }
    }

    // Apply the mock using Bun's mock function
    mock.module(modulePath, mockImplementation);
  }

  /**
   * Reset a specific module mock
   */
  static resetMock(modulePath: string): void {
    const moduleState = EnhancedModuleMocker.activeModules.get(modulePath);
    if (moduleState) {
      moduleState.isActive = false;
      // Bun's mock system handles the actual reset
    }
  }

  /**
   * Reset all active module mocks
   */
  static resetAllMocks(): void {
    for (const moduleState of EnhancedModuleMocker.activeModules.values()) {
      moduleState.isActive = false;
    }
    EnhancedModuleMocker.activeModules.clear();
  }

  /**
   * Get active module mock statistics
   */
  static getActiveMockStats(): { total: number; active: number; modules: string[] } {
    const activeModules = Array.from(EnhancedModuleMocker.activeModules.values());
    const activeCount = activeModules.filter(m => m.isActive).length;
    
    return {
      total: activeModules.length,
      active: activeCount,
      modules: activeModules.map(m => m.modulePath)
    };
  }
}

/**
 * Create an enhanced mock filesystem with automatic cleanup
 */
export function createEnhancedMockFileSystem(initialFiles: Record<string, string> = {}): EnhancedMockFileSystem {
  return new EnhancedMockFileSystem(initialFiles);
}

/**
 * Enhanced test environment setup with comprehensive mocking
 */
export function setupEnhancedMocking(): {
  mockFS: EnhancedMockFileSystem;
  mockModule: typeof EnhancedModuleMocker.mockModule;
  resetMocks: () => void;
  } {
  EnhancedModuleMocker.setupAutoCleanup();
  
  const mockFS = new EnhancedMockFileSystem();
  
  const resetMocks = () => {
    mockFS.reset();
    EnhancedModuleMocker.resetAllMocks();
  };

  // Register cleanup
  cleanupManager.registerCleanupFunction(resetMocks);

  return {
    mockFS,
    mockModule: EnhancedModuleMocker.mockModule,
    resetMocks
  };
}

/**
 * Validate that all mocks are properly isolated
 */
export function validateMockIsolation(): { isIsolated: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check for active filesystem instances
  const fsInstances = EnhancedMockFileSystem.activeInstances.size;
  if (fsInstances > 1) {
    issues.push(`Multiple active filesystem instances detected: ${fsInstances}`);
  }

  // Check for active module mocks
  const mockStats = EnhancedModuleMocker.getActiveMockStats();
  if (mockStats.active > 0) {
    issues.push(`Active module mocks detected: ${mockStats.modules.join(", ")}`);
  }

  return {
    isIsolated: issues.length === 0,
    issues
  };
} 
