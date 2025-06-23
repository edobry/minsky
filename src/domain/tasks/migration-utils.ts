/**
 * Migration utilities for transitioning from markdown to JSON task storage
 *
 * These utilities help migrate existing tasks.md files to the new JSON database format
 * while preserving all task data and maintaining compatibility.
 */

import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import type {} from "../../types/tasks/taskData";
import { createJsonFileStorage } from "../storage/json-file-storage";
import { log } from "../../utils/logger";

/**
 * Get the user's home directory in a cross-platform way
 * @returns Home directory path
 */
function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

/**
 * Configuration for migration operations
 */
export interface MigrationConfig {
  /** Path to the workspace containing tasks.md */
  workspacePath: string;
  /** Path to the target JSON database file (optional) */
  targetDbPath?: string;
  /** Whether to create a backup of tasks.md before migration */
  createBackup?: boolean;
  /** Whether to preserve the original tasks.md file after migration */
  preserveOriginal?: boolean;
}

/**
 * Result of a migration operation
 */
export interface MigrationResult {
  success: boolean;
  error?: Error;
  /** Number of tasks migrated */
  tasksMigrated: number;
  /** Path to the original tasks.md file */
  originalFile?: string;
  /** Path to the new JSON database file */
  newDbFile?: string;
  /** Path to backup file if created */
  backupFile?: string;
}

/**
 * Migration utilities class
 */
export class TaskMigrationUtils {
  private readonly workspacePath: string;
  private readonly targetDbPath: string;
  private readonly createBackup: boolean;
  private readonly preserveOriginal: boolean;

  constructor(_config: MigrationConfig) {
    this.workspacePath = config.workspacePath;
    this.targetDbPath =
      config.targetDbPath || join(getHomeDirectory(), ".local", "state", "minsky", "tasks.json");
    this.createBackup = config.createBackup !== false;
    this.preserveOriginal = config.preserveOriginal !== false;
  }

  /**
   * Migrate tasks from tasks.md to JSON database
   * @returns Promise resolving to migration result
   */
  async migrateToJson(): Promise<MigrationResult> {
    const tasksFilePath = join(this._workspacePath, "process", "tasks.md");
    let backupFile: string | undefined;

    try {
      // Check if tasks.md exists
      try {
        await access(tasksFilePath);
      } catch {
        return {
          success: false,
          error: new Error(`tasks.md not found at ${tasksFilePath}`),
          tasksMigrated: 0,
          originalFile: tasksFilePath,
        };
      }

      // Read and parse tasks.md
      const _content = (await readFile(tasksFilePath, "utf8")) as string;
      const _tasks = this.parseMarkdownTasks(_content);

      if (tasks.length === 0) {
        log.debug("No tasks found in tasks.md to migrate");
        return {
          success: true,
          tasksMigrated: 0,
          originalFile: tasksFilePath,
          newDbFile: this.targetDbPath,
        };
      }

      // Create backup if requested
      if (this.createBackup) {
        backupFile = `${tasksFilePath}.backup.${Date.now()}`;
        await writeFile(backupFile, _content, "utf8");
        log.debug(`Created backup at ${backupFile}`);
      }

      // Create JSON storage and initialize
      const storage = createJsonFileStorage<TaskState>({
        filePath: this.targetDbPath,
        entitiesField: "tasks",
        idField: "id",
        initializeState: () => ({
          tasks: [],
          lastUpdated: new Date().toISOString(),
          metadata: {
            migratedFrom: tasksFilePath,
            migrationDate: new Date().toISOString(),
          },
        }),
        prettyPrint: true,
      });

      // Initialize storage
      await storage.initialize();

      // Read existing state (in case there are already tasks)
      const stateResult = await storage.readState();
      const existingTasks = stateResult.success && stateResult.data ? stateResult.data.tasks : [];

      // Merge with migrated tasks, avoiding duplicates
      const mergedTasks = this.mergeTasks(existingTasks, _tasks);

      // Create new state
      const newState: TaskState = {
        tasks: mergedTasks,
        lastUpdated: new Date().toISOString(),
        metadata: {
          migratedFrom: tasksFilePath,
          migrationDate: new Date().toISOString(),
          originalTaskCount: tasks.length,
          totalTaskCount: mergedTasks.length,
        },
      };

      // Write to storage
      const writeResult = await storage.writeState(newState);
      if (!writeResult.success) {
        throw writeResult.error || new Error("Failed to write migrated data to JSON storage");
      }

      log.debug(
        `Successfully migrated ${tasks.length} tasks to JSON database at ${this.targetDbPath}`
      );

      return {
        success: true,
        tasksMigrated: tasks.length,
        originalFile: tasksFilePath,
        newDbFile: this.targetDbPath,
        backupFile,
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Migration failed", { error: typedError.message });

      return {
        success: false,
        error: typedError,
        tasksMigrated: 0,
        originalFile: tasksFilePath,
        newDbFile: this.targetDbPath,
        backupFile,
      };
    }
  }

  /**
   * Migrate tasks from JSON database back to tasks.md format
   * @returns Promise resolving to migration result
   */
  async migrateFromJson(): Promise<MigrationResult> {
    const tasksFilePath = join(this._workspacePath, "process", "tasks.md");
    let backupFile: string | undefined;

    try {
      // Create JSON storage instance
      const storage = createJsonFileStorage<TaskState>({
        filePath: this.targetDbPath,
        entitiesField: "tasks",
        idField: "id",
        initializeState: () => ({
          tasks: [],
          lastUpdated: new Date().toISOString(),
          metadata: {},
        }),
        prettyPrint: true,
      });

      // Read tasks from JSON storage
      const stateResult = await storage.readState();
      if (!stateResult.success || !stateResult.data) {
        return {
          success: false,
          error: new Error(`Failed to read JSON database at ${this.targetDbPath}`),
          tasksMigrated: 0,
          originalFile: this.targetDbPath,
          newDbFile: tasksFilePath,
        };
      }

      const _tasks = stateResult.data.tasks;

      // Create backup of existing tasks.md if it exists
      if (this.createBackup) {
        try {
          await access(tasksFilePath);
          const existingContent = await readFile(tasksFilePath, "utf8");
          backupFile = `${tasksFilePath}.backup.${Date.now()}`;
          await writeFile(backupFile, existingContent, "utf8");
          log.debug(`Created backup at ${backupFile}`);
        } catch {
          // tasks.md doesn't exist, no backup needed
        }
      }

      // Convert tasks to markdown format
      const markdownContent = this.formatTasksToMarkdown(_tasks);

      // Write to tasks.md
      await writeFile(tasksFilePath, markdownContent, "utf8");

      log.debug(
        `Successfully migrated ${tasks.length} tasks from JSON database to ${tasksFilePath}`
      );

      return {
        success: true,
        tasksMigrated: tasks.length,
        originalFile: this.targetDbPath,
        newDbFile: tasksFilePath,
        backupFile,
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Reverse migration failed", { error: typedError.message });

      return {
        success: false,
        error: typedError,
        tasksMigrated: 0,
        originalFile: this.targetDbPath,
        newDbFile: tasksFilePath,
        backupFile,
      };
    }
  }

  /**
   * Compare tasks.md and JSON database to detect sync issues
   * @returns Promise resolving to comparison result
   */
  async compareFormats(): Promise<{
    success: boolean;
    error?: Error;
    markdownTasks: TaskData[];
    jsonTasks: TaskData[];
    differences: {
      onlyInMarkdown: TaskData[];
      onlyInJson: TaskData[];
      different: Array<{ id: string; markdown: TaskData; json: TaskData }>;
    };
  }> {
    try {
      const tasksFilePath = join(this._workspacePath, "process", "tasks.md");

      // Read markdown tasks
      let markdownTasks: TaskData[] = [];
      try {
        const _content = (await readFile(tasksFilePath, "utf8")) as string;
        markdownTasks = this.parseMarkdownTasks(_content);
      } catch {
        // tasks.md doesn't exist or can't be read
      }

      // Read JSON tasks
      let jsonTasks: TaskData[] = [];
      try {
        const storage = createJsonFileStorage<TaskState>({
          filePath: this.targetDbPath,
          entitiesField: "tasks",
          idField: "id",
          initializeState: () => ({
            tasks: [],
            lastUpdated: new Date().toISOString(),
            metadata: {},
          }),
          prettyPrint: true,
        });

        const stateResult = await storage.readState();
        if (stateResult.success && stateResult.data) {
          jsonTasks = stateResult.data.tasks;
        }
      } catch {
        // JSON database doesn't exist or can't be read
      }

      // Compare tasks
      const differences = this.compareTasks(markdownTasks, jsonTasks);

      return {
        success: true,
        markdownTasks,
        jsonTasks,
        differences,
      };
    } catch {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        error: typedError,
        markdownTasks: [],
        jsonTasks: [],
        differences: {
          onlyInMarkdown: [],
          onlyInJson: [],
          different: [],
        },
      };
    }
  }

  // ---- Private helper methods ----

  /**
   * Parse tasks from markdown content
   * @param content Markdown content
   * @returns Array of task data
   * @private
   */
  private parseMarkdownTasks(_content: string): TaskData[] {
    const _tasks: TaskData[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ")) {
        const completed = trimmed.startsWith("- [x] ");
        const taskLine = trimmed.slice(6); // Remove '- [ ] ' or '- [x] '

        // Extract task ID and title from different possible formats
        let id = "";
        let _title = "";
        let _specPath = "";

        // Try format: Title [#123](path/to/spec.md)
        const linkMatch = taskLine.match(/^(.+?)\s+\[#(\d+)\]\(([^)]+)\)/);
        if (linkMatch && linkMatch[1] && linkMatch[2] && linkMatch[3]) {
          title = linkMatch[1].trim();
          id = `#${linkMatch[2]}`;
          specPath = linkMatch[3];
        } else {
          // Try format: [Title](path/to/spec.md) [#123]
          const altMatch = taskLine.match(/^\[([^\]]+)\]\(([^)]+)\)\s+\[#(\d+)\]/);
          if (altMatch && altMatch[1] && altMatch[2] && altMatch[3]) {
            title = altMatch[1];
            specPath = altMatch[2];
            id = `#${altMatch[3]}`;
          } else {
            // Try simple format: Title #123
            const simpleMatch = taskLine.match(/^(.+?)\s+#(\d+)$/);
            if (simpleMatch && simpleMatch[1] && simpleMatch[2]) {
              title = simpleMatch[1].trim();
              id = `#${simpleMatch[2]}`;
            } else {
              // Fallback: use the entire line as title
              title = taskLine;
              id = `#${Date.now()}`; // Generate a temporary ID
            }
          }
        }

        if (title && id) {
          tasks.push({
            id,
            _title,
            _status: completed ? "DONE" : "TODO",
            _specPath: specPath || undefined,
          });
        }
      }
    }

    return tasks;
  }

  /**
   * Format tasks to markdown content
   * @param tasks Array of task data
   * @returns Formatted markdown content
   * @private
   */
  private formatTasksToMarkdown(_tasks: TaskData[]): string {
    const lines: string[] = [];

    // Add header
    lines.push("# Tasks");
    lines.push("");

    // Add tasks
    for (const task of tasks) {
      const checkbox = task.status === "DONE" ? "[x]" : "[ ]";
      if (task.specPath) {
        lines.push(`- ${checkbox} ${task.title} [${task.id}](${task.specPath})`);
      } else {
        lines.push(`- ${checkbox} ${task.title} ${task.id}`);
      }
    }

    return `${lines.join("\n")  }\n`;
  }

  /**
   * Merge tasks arrays, avoiding duplicates
   * @param existing Existing tasks
   * @param incoming New tasks to merge
   * @returns Merged tasks array
   * @private
   */
  private mergeTasks(existing: TaskData[], incoming: TaskData[]): TaskData[] {
    const merged = [...existing];
    const existingIds = new Set(existing.map((t) => t.id));

    for (const task of incoming) {
      if (!existingIds.has(task.id)) {
        merged.push(task);
      }
    }

    return merged;
  }

  /**
   * Compare two task arrays and find differences
   * @param markdownTasks Tasks from markdown
   * @param jsonTasks Tasks from JSON
   * @returns Comparison result
   * @private
   */
  private compareTasks(markdownTasks: TaskData[], jsonTasks: TaskData[]) {
    const markdownMap = new Map(markdownTasks.map((t) => [t.id, t]));
    const jsonMap = new Map(jsonTasks.map((t) => [t.id, t]));

    const onlyInMarkdown: TaskData[] = [];
    const onlyInJson: TaskData[] = [];
    const different: Array<{ id: string; markdown: TaskData; json: TaskData }> = [];

    // Find tasks only in markdown
    for (const task of markdownTasks) {
      if (!jsonMap.has(task.id)) {
        onlyInMarkdown.push(task);
      } else {
        // Check if they're different
        const jsonTask = jsonMap.get(task.id)!;
        if (!this.tasksEqual(task, jsonTask)) {
          different.push({ _id: task.id, markdown: task, json: jsonTask });
        }
      }
    }

    // Find tasks only in JSON
    for (const task of jsonTasks) {
      if (!markdownMap.has(task.id)) {
        onlyInJson.push(task);
      }
    }

    return {
      onlyInMarkdown,
      onlyInJson,
      different,
    };
  }

  /**
   * Check if two tasks are equal
   * @param task1 First task
   * @param task2 Second task
   * @returns True if tasks are equal
   * @private
   */
  private tasksEqual(task1:task2: TaskData): boolean {
    return (
      task1.id === task2.id &&
      task1.title === task2.title &&
      task1.status === task2.status &&
      task1.specPath === task2.specPath
    );
  }
}

/**
 * Create a new TaskMigrationUtils instance
 * @param config Migration configuration
 * @returns TaskMigrationUtils instance
 */
export function createMigrationUtils(_config: MigrationConfig): TaskMigrationUtils {
  return new TaskMigrationUtils(_config);
}

/**
 * Convenience function to migrate a workspace to JSON format
 * @param workspacePath Path to workspace containing tasks.md
 * @param options Migration options
 * @returns Promise resolving to migration result
 */
export async function migrateWorkspaceToJson(
  _workspacePath: string,
  _options?: Partial<MigrationConfig>
): Promise<MigrationResult> {
  const utils = createMigrationUtils({
    _workspacePath,
    ..._options,
  });
  return utils.migrateToJson();
}

/**
 * Convenience function to migrate from JSON back to markdown format
 * @param workspacePath Path to workspace for tasks.md
 * @param options Migration options
 * @returns Promise resolving to migration result
 */
export async function migrateWorkspaceFromJson(
  _workspacePath: string,
  _options?: Partial<MigrationConfig>
): Promise<MigrationResult> {
  const utils = createMigrationUtils({
    _workspacePath,
    ..._options,
  });
  return utils.migrateFromJson();
}
