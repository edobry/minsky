/**
 * Test isolation utilities for preventing cross-test contamination.
 * 
 * This module provides utilities for:
 * - Creating isolated test environments
 * - Generating unique test data sets
 * - Managing test-specific workspace creation
 * - Ensuring database isolation for integration tests
 * 
 * @module test-isolation
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { log } from "../logger";
import { cleanupManager } from "./cleanup";

interface TestDataFactoryOptions {
  prefix?: string;
  uniqueId?: boolean;
  taskCount?: number;
  includeMetadata?: boolean;
}

/**
 * Test data factory for generating unique, isolated test datasets
 */
export class TestDataFactory {
  private static instanceCount = 0;
  private readonly instanceId: string;

  constructor() {
    TestDataFactory.instanceCount++;
    this.instanceId = `factory-${TestDataFactory.instanceCount}-${Date.now()}`;
  }

  /**
   * Create unique task data for testing
   */
  createTaskData(options: TestDataFactoryOptions = {}): {
    id: string;
    title: string;
    description: string;
    status: string;
    specPath: string;
    metadata?: any;
  } {
    const {
      prefix = "test-task",
      uniqueId = true,
      includeMetadata = true
    } = options;

    // Generate numeric task ID in expected format (#001, #002, etc.)
    const numericId = uniqueId 
      ? String(TestDataFactory?.instanceCount + Math.floor(Math.random() * 900) + 100).padStart(3, "0")
      : String(TestDataFactory.instanceCount).padStart(3, "0");
    
    const taskId = `#${numericId}`;
    const title = `${prefix.charAt(0).toUpperCase() + prefix.slice(1)} Task`;

    const data = {
      id: taskId,
      title: title,
      description: `Test description for ${taskId}`,
      status: "TODO",
      specPath: `process/tasks/${numericId}-${prefix.replace(/[^a-z0-9]+/g, "-").toLowerCase()}.md`
    };

    return includeMetadata 
      ? { ...data, metadata: { created: new Date().toISOString(), testId: this.instanceId } }
      : data;
  }

  /**
   * Create multiple unique tasks
   */
  createMultipleTaskData(count: number, options: TestDataFactoryOptions = {}): Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    specPath: string;
    metadata?: any;
  }> {
    return Array.from({ length: count }, () => this.createTaskData(options));
  }

  /**
   * Get factory instance information
   */
  getInstanceInfo(): { instanceId: string; createdCount: number } {
    return {
      instanceId: this.instanceId,
      createdCount: TestDataFactory.instanceCount
    };
  }
}

/**
 * Database isolation utilities for integration tests
 */
export class DatabaseIsolation {
  private static activeDatabases: Map<string, string> = new Map();

  /**
   * Create an isolated database for testing
   */
  static async createIsolatedDatabase(name: string, initialData: any = {}): Promise<{
    dbPath: string;
    dbId: string;
    cleanup: () => Promise<void>;
  }> {
    const dbId = `${name}-${Date.now()}-${randomUUID().substring(0, 8)}`;
    const dbPath = path.join(require("os").tmpdir(), "minsky-test-dbs", `${dbId}.json`);

    // Ensure database directory exists
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });

    // Create initial database content
    const dbContent = {
      metadata: {
        dbId,
        created: new Date().toISOString(),
        testDatabase: true
      },
      ...initialData
    };

    await fs.promises.writeFile(dbPath, JSON.stringify(dbContent, null, 2));
    DatabaseIsolation.activeDatabases.set(dbId, dbPath);

    // Register for cleanup
    cleanupManager.registerForCleanup(dbPath, "file", `Test database ${dbId}`);

    const cleanup = async (): Promise<void> => {
      try {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
        DatabaseIsolation.activeDatabases.delete(dbId);
      } catch (error) {
        log.warn(`Failed to cleanup database ${dbId}: ${error instanceof Error ? error?.message : String(error as Error)}`);
      }
    };

    return {
      dbPath,
      dbId,
      cleanup
    };
  }

  /**
   * Get active database count
   */
  static getActiveDatabaseCount(): number {
    return DatabaseIsolation.activeDatabases.size;
  }

  /**
   * Cleanup all test databases
   */
  static async cleanupAllDatabases(): Promise<void> {
    const cleanupPromises = Array.from(DatabaseIsolation.activeDatabases.values())
      .map(async (dbPath) => {
        if (fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }
      });

    await Promise.all(cleanupPromises);
    DatabaseIsolation.activeDatabases.clear();
  }
}

// Global instances for easy access
export const testDataFactory = new TestDataFactory();
