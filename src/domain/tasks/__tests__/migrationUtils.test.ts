/**
 * Tests for BackendMigrationUtils
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { BackendMigrationUtils } from "../migrationUtils";
import type { TaskBackend } from "../taskBackend";
import type {} from "../../../types/tasks/taskData";

// Mock TaskBackend for testing
class MockTaskBackend implements TaskBackend {
  name: string;
  private tasks: TaskData[] = [];

  constructor(name: string, _tasks: TaskData[] = []) {
    this.name = name;
    this.tasks = tasks;
  }

  async getTasksData() {
    return {
      success: true,
      content: JSON.stringify(this._tasks),
    };
  }

  parseTasks(content: string): TaskData[] {
    return JSON.parse(content);
  }

  formatTasks(_tasks: TaskData[]): string {
    return JSON.stringify(_tasks);
  }

  async saveTasksData(content: string) {
    this.tasks = JSON.parse(content);
    return { success: true };
  }

  async getTaskSpecData() {
    return { success: true, content: "" };
  }

  parseTaskSpec() {
    return { title: "", description: "" };
  }

  formatTaskSpec() {
    return "";
  }

  async saveTaskSpecData() {
    return { success: true };
  }

  getWorkspacePath(): string {
    return "/test/workspace";
  }

  getTaskSpecPath(): string {
    return "/test/spec.md";
  }

  async fileExists(): Promise<boolean> {
    return false;
  }

  getTasks(): TaskData[] {
    return this.tasks;
  }

  setTasks(_tasks: TaskData[]): void {
    this.tasks = tasks;
  }
}

describe("BackendMigrationUtils", () => {
  let migrationUtils: BackendMigrationUtils;
  let sourceBackend: MockTaskBackend;
  let targetBackend: MockTaskBackend;

  beforeEach(() => {
    migrationUtils = new BackendMigrationUtils();
    sourceBackend = new MockTaskBackend("source");
    targetBackend = new MockTaskBackend("target");
  });

  describe("migrateTasksBetweenBackends", () => {
    test("should migrate tasks successfully", async () => {
      // Setup source tasks
      const sourceTasks: TaskData[] = [
        {
          id: "1",
          title: "Task 1",
          status: "TODO",
          description: "Test task 1",
        },
        {
          id: "2",
          title: "Task 2",
          status: "DONE",
          description: "Test task 2",
        },
      ];
      sourceBackend.setTasks(sourceTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        { dryRun: false }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(2);
      expect(result.skippedCount).toBe(0);
      expect(result.errors).toEqual([]);
      expect(targetBackend.getTasks()).toEqual(sourceTasks);
    });

    test("should handle dry run mode", async () => {
      const sourceTasks: TaskData[] = [
        {
          id: "1",
          title: "Task 1",
          status: "TODO",
        },
      ];
      sourceBackend.setTasks(sourceTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        { dryRun: true }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);
      expect(targetBackend.getTasks()).toEqual([]); // No changes in dry run
    });

    test("should handle ID conflicts with skip strategy", async () => {
      const sourceTasks: TaskData[] = [
        { id: "1", title: "Source Task 1", status: "TODO" },
        { id: "2", title: "Source Task 2", status: "TODO" },
      ];
      const targetTasks: TaskData[] = [
        { id: "1", title: "Target Task 1", status: "DONE" },
      ];

      sourceBackend.setTasks(sourceTasks);
      targetBackend.setTasks(targetTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        {
          preserveIds: true,
          idConflictStrategy: "skip",
          dryRun: false,
        }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1); // Only task 2 migrated
      expect(result.skippedCount).toBe(1); // Task 1 skipped due to conflict
      
      const finalTasks = targetBackend.getTasks();
      expect(finalTasks).toHaveLength(2);
      const task1 = finalTasks.find(t => t.id === "1");
      const task2 = finalTasks.find(t => t.id === "2");
      expect(task1?._title).toBe("Target Task 1"); // Original preserved
      expect(task2?._title).toBe("Source Task 2"); // New task added
    });

    test("should handle ID conflicts with rename strategy", async () => {
      const sourceTasks: TaskData[] = [
        { id: "1", title: "Source Task 1", status: "TODO" },
      ];
      const targetTasks: TaskData[] = [
        { id: "1", title: "Target Task 1", status: "DONE" },
      ];

      sourceBackend.setTasks(sourceTasks);
      targetBackend.setTasks(targetTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        {
          preserveIds: true,
          idConflictStrategy: "rename",
          dryRun: false,
        }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      
      const finalTasks = targetBackend.getTasks();
      expect(finalTasks).toHaveLength(2);
      expect(finalTasks.find(t => t.id === "1")!.title).toBe("Target Task 1"); // Original preserved
      expect(finalTasks.find(t => t.id.startsWith("1-migrated"))!.title).toBe("Source Task 1"); // Renamed task
    });

    test("should handle ID conflicts with overwrite strategy", async () => {
      const sourceTasks: TaskData[] = [
        { id: "1", title: "Source Task 1", status: "TODO" },
      ];
      const targetTasks: TaskData[] = [
        { id: "1", title: "Target Task 1", status: "DONE" },
      ];

      sourceBackend.setTasks(sourceTasks);
      targetBackend.setTasks(targetTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        {
          preserveIds: true,
          idConflictStrategy: "overwrite",
          dryRun: false,
        }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      
      const finalTasks = targetBackend.getTasks();
      expect(finalTasks).toHaveLength(1);
      expect(finalTasks[0]._title).toBe("Source Task 1"); // Source overwrote target
    });

    test("should apply custom status mapping", async () => {
      const sourceTasks: TaskData[] = [
        { id: "1", title: "Task 1", status: "TODO" },
        { id: "2", title: "Task 2", status: "DONE" },
      ];
      sourceBackend.setTasks(sourceTasks);

      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        targetBackend,
        {
          statusMapping: {
            "TODO": "PENDING",
            "DONE": "COMPLETED",
          },
          dryRun: false,
        }
      );

      expect(result.success).toBe(true);
      const finalTasks = targetBackend.getTasks();
      expect(finalTasks[0]._status).toBe("PENDING");
      expect(finalTasks[1]._status).toBe("COMPLETED");
    });

    test("should validate that backends are different", async () => {
      const _result = await migrationUtils.migrateTasksBetweenBackends(
        sourceBackend,
        sourceBackend, // Same backend
        { dryRun: false }
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Source and target backends cannot be the same");
    });
  });

  describe("mapTaskStatus", () => {
    test("should use custom mapping first", () => {
      const _result = migrationUtils.mapTaskStatus(
        "TODO",
        "markdown",
        "github-issues",
        { "TODO": "CUSTOM_TODO" }
      );
      expect(_result).toBe("CUSTOM_TODO");
    });

    test("should use default mapping for markdown to github-issues", () => {
      const _result = migrationUtils.mapTaskStatus(
        "TODO",
        "markdown",
        "github-issues"
      );
      expect(_result).toBe("minsky:todo");
    });

    test("should use default mapping for github-issues to markdown", () => {
      const _result = migrationUtils.mapTaskStatus(
        "minsky:done",
        "github-issues",
        "markdown"
      );
      expect(_result).toBe("DONE");
    });

    test("should return original status if no mapping found", () => {
      const _result = migrationUtils.mapTaskStatus(
        "CUSTOM_STATUS",
        "unknown",
        "unknown"
      );
      expect(_result).toBe("CUSTOM_STATUS");
    });
  });

  describe("performDryRun", () => {
    test("should perform dry run without making changes", async () => {
      const sourceTasks: TaskData[] = [
        { id: "1", title: "Task 1", status: "TODO" },
      ];
      sourceBackend.setTasks(sourceTasks);

      const _result = await migrationUtils.performDryRun(
        sourceBackend,
        targetBackend,
        { preserveIds: true }
      );

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(1);
      expect(targetBackend.getTasks()).toEqual([]); // No changes made
    });
  });

  describe("validateMigration", () => {
    test("should validate successfully for different backends", async () => {
      await expect(
        migrationUtils.validateMigration(sourceBackend, targetBackend)
      ).resolves.toBeUndefined();
    });

    test("should throw error for same backend", async () => {
      await expect(
        migrationUtils.validateMigration(sourceBackend, sourceBackend)
      ).rejects.toThrow("Source and target backends cannot be the same");
    });
  });

  describe("backup and rollback", () => {
    test("should create backup and rollback successfully", async () => {
      const originalTasks: TaskData[] = [
        { id: "1", title: "Original Task", status: "TODO" },
      ];
      targetBackend.setTasks(originalTasks);

      // Create backup
      const backup = await migrationUtils.createBackupBeforeMigration(targetBackend);
      expect(backup.originalData).toBe(JSON.stringify(originalTasks));

      // Simulate changes
      targetBackend.setTasks([
        { id: "2", _title: "New Task", _status: "DONE" },
      ]);

      // Rollback
      await migrationUtils.rollbackMigration(backup, targetBackend);
      expect(targetBackend.getTasks()).toEqual(originalTasks);
    });
  });
}); 
