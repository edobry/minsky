/**
 * Test Cleanup Patterns Utility
 * 
 * Comprehensive cleanup patterns for test isolation to eliminate global state
 * interference and ensure tests pass individually and in full suite.
 */

import { tmpdir } from "os";
import { join, dirname } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";

/**
 * File System Cleanup Pattern
 * 
 * Creates and manages temporary directories for tests with automatic cleanup.
 * Prevents file system state pollution between tests.
 */
export class FileSystemTestCleanup {
  private testDirs: string[] = [];
  private testFiles: string[] = [];

  /**
   * Create a unique temporary directory for a test
   */
  createTempDir(prefix: string = "test"): string {
    const timestamp = Date.now();
    const uuid = randomUUID();
    const uniqueId = `${prefix}-${timestamp}-${uuid}`;
    const tempDir = join(tmpdir(), uniqueId);
    
    mkdirSync(tempDir, { recursive: true });
    this.testDirs.push(tempDir);
    return tempDir;
  }

  /**
   * Create a temporary file with optional content
   */
  createTempFile(filename: string, content: string = "", basePath?: string): string {
    const dir = basePath || this.createTempDir("file-test");
    const filePath = join(dir, filename);
    
    // Ensure parent directory exists
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    
    this.testFiles.push(filePath);
    return filePath;
  }

  /**
   * Clean up all created directories and files
   */
  cleanup(): void {
    // Clean up files first
    for (const file of this.testFiles) {
      try {
        if (existsSync(file)) {
          rmSync(file, { force: true });
        }
      } catch (error) {
        console.warn(`Failed to clean up test file ${file}:`, error);
      }
    }

    // Clean up directories
    for (const dir of this.testDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (error) {
        console.warn(`Failed to clean up test directory ${dir}:`, error);
      }
    }

    this.testDirs = [];
    this.testFiles = [];
  }
}

/**
 * Configuration Override Pattern
 * 
 * Provides configuration overrides for dependency injection instead of
 * modifying global state like process.env.
 */
export class ConfigurationTestOverrides {
  /**
   * Create sessiondb configuration override for testing
   */
  static createSessionDbOverride(backend: "json" | "sqlite" | "postgres", options: {
    dbPath?: string;
    connectionString?: string;
    baseDir?: string;
  } = {}): any {
    const override: any = {
      sessiondb: {
        backend,
        enableIntegrityCheck: false, // Disable for faster tests
        autoMigrate: false,
        promptOnIntegrityIssues: false,
        ...options,
      },
    };

    return override;
  }

  /**
   * Create task backend configuration override
   */
  static createTaskBackendOverride(backend: string, backendConfig: any = {}): any {
    return {
      backend,
      backendConfig,
    };
  }

  /**
   * Create AI configuration override for testing
   */
  static createAiOverride(provider: string = "mock"): any {
    return {
      ai: {
        default_provider: provider,
        providers: {
          [provider]: {
            credentials: { source: "environment" },
            max_tokens: 100,
            temperature: 0.0,
          },
        },
      },
    };
  }
}

/**
 * Database Test Cleanup Pattern
 * 
 * Manages database creation and cleanup for tests that need databases.
 */
export class DatabaseTestCleanup {
  private databases: string[] = [];
  private fileCleanup: FileSystemTestCleanup;

  constructor(fileCleanup: FileSystemTestCleanup) {
    this.fileCleanup = fileCleanup;
  }

  /**
   * Create a temporary SQLite database for testing
   */
  createSqliteDb(filename: string = "test.db"): string {
    const dbPath = this.fileCleanup.createTempFile(filename);
    this.databases.push(dbPath);
    return dbPath;
  }

  /**
   * Create a temporary JSON database file for testing
   */
  createJsonDb(filename: string = "test.json", initialData: any = { sessions: [], baseDir: "/test" }): string {
    const content = JSON.stringify(initialData, null, 2);
    const dbPath = this.fileCleanup.createTempFile(filename, content);
    this.databases.push(dbPath);
    return dbPath;
  }

  /**
   * Clean up all databases
   */
  cleanup(): void {
    this.databases = [];
    // File cleanup is handled by FileSystemTestCleanup
  }
}

/**
 * Comprehensive Test Isolation Manager
 * 
 * Combines all cleanup patterns into a single, easy-to-use interface.
 */
export class TestIsolationManager {
  private fileCleanup: FileSystemTestCleanup;
  private dbCleanup: DatabaseTestCleanup;

  constructor() {
    this.fileCleanup = new FileSystemTestCleanup();
    this.dbCleanup = new DatabaseTestCleanup(this.fileCleanup);
  }

  // Expose individual cleanup utilities
  get fileSystem() { return this.fileCleanup; }
  get database() { return this.dbCleanup; }
  get config() { return ConfigurationTestOverrides; }

  /**
   * Complete cleanup - call this in afterEach
   */
  cleanup(): void {
    this.dbCleanup.cleanup();
    this.fileCleanup.cleanup();
  }
}

/**
 * Ready-to-use test patterns
 */

/**
 * Basic file system test pattern
 */
export function withFileSystemCleanup() {
  const manager = new TestIsolationManager();
  
  return {
    manager,
    beforeEach: () => {
      // Setup runs automatically when methods are called
    },
    afterEach: () => {
      manager.cleanup();
    },
  };
}

/**
 * Configuration override test pattern
 */
export function withConfigOverrides<T>(baseConfig: T) {
  return {
    createOverride: (overrides: Partial<T>) => ({ ...baseConfig, ...overrides }),
    sessionDb: ConfigurationTestOverrides.createSessionDbOverride,
    taskBackend: ConfigurationTestOverrides.createTaskBackendOverride,
    ai: ConfigurationTestOverrides.createAiOverride,
  };
}

/**
 * Complete test isolation pattern
 */
export function withTestIsolation() {
  const manager = new TestIsolationManager();
  
  return {
    manager,
    beforeEach: () => {
      // All setup is lazy - happens when methods are called
    },
    afterEach: () => {
      manager.cleanup();
    },
    // Convenience methods
    createTempDir: (prefix?: string) => manager.fileSystem.createTempDir(prefix),
    createTempFile: (filename: string, content?: string, basePath?: string) => 
      manager.fileSystem.createTempFile(filename, content, basePath),
    createSqliteDb: (filename?: string) => manager.database.createSqliteDb(filename),
    createJsonDb: (filename?: string, data?: any) => manager.database.createJsonDb(filename, data),
    sessionDbConfig: ConfigurationTestOverrides.createSessionDbOverride,
    taskBackendConfig: ConfigurationTestOverrides.createTaskBackendOverride,
  };
} 
