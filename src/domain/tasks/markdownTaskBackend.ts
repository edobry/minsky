/**
 * Markdown Task Backend Implementation
 * Uses functional patterns with clear separation of concerns
 */

import { join, dirname } from "path";
import { promises as fs } from "fs";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
// @ts-ignore - matter is a third-party library
import matter from "gray-matter";
import { createGitService, type GitServiceInterface } from "../git";

import type {
  TaskBackend,
  Task,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
} from "../tasks";
import { getTaskById } from "./taskFunctions";
import type { BackendCapabilities } from "./types";
import type {
  TaskData,
  TaskSpecData,
  TaskBackendConfig,
  TaskReadOperationResult,
  TaskWriteOperationResult,
} from "../../types/tasks/taskData";
import { TaskStatus, TASK_STATUS } from "./taskConstants";

import {
  parseTasksFromMarkdown,
  formatTasksToMarkdown,
  parseTaskSpecFromMarkdown,
  formatTaskSpecToMarkdown,
} from "./taskFunctions";

import {
  readTasksFile,
  writeTasksFile,
  readTaskSpecFile,
  writeTaskSpecFile,
  fileExists as checkFileExists,
  getTasksFilePath,
  getTaskSpecFilePath,
  getTaskSpecRelativePath,
} from "./taskIO";

import { validateQualifiedTaskId, formatTaskIdForDisplay, getTaskIdNumber } from "./task-id-utils";

// Helper import to avoid promise conversion issues
import { readdir } from "fs/promises";

/**
 * MarkdownTaskBackend implementation
 * Uses functional patterns to separate concerns
 */
export class MarkdownTaskBackend implements TaskBackend {
  name = "markdown";
  private readonly workspacePath: string;
  private readonly filePath: string;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.filePath = path.join(this.workspacePath, "process", "tasks.md");
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const tasks = await this.parseTasks();

    // Apply filters
    let filtered = tasks;
    if (options?.status && options.status !== "all") {
      filtered = filtered.filter((task) => task.status === options.status);
    }
    if (options?.backend) {
      filtered = filtered.filter((task) => task.backend === options.backend);
    }

    return filtered;
  }

  async getTask(id: string): Promise<Task | null> {
    const tasks = await this.listTasks();

    // Handle ID format mismatches for multi-backend compatibility
    const foundTask = tasks.find((task) => {
      // Exact match first
      if (task.id === id) return true;

      // Extract local IDs for comparison
      const taskLocalId = task.id.includes("#") ? task.id.split("#").pop() : task.id;
      const searchLocalId = id.includes("#") ? id.split("#").pop() : id;

      // Compare local IDs (e.g., "update-test" vs "update-test")
      if (taskLocalId === searchLocalId) return true;

      // Handle # prefix variations for legacy compatibility
      if (!/^#/.test(id) && task.id === `#${id}`) return true;
      if (id.startsWith("#") && task.id === id.substring(1)) return true;

      return false;
    });

    return foundTask || null;
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    log.debug("markdownTaskBackend setTaskStatus called", { id, status });

    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      throw new Error("Failed to read tasks data");
    }

    const tasks = this.parseTasks(result.content);
    log.debug("stored task IDs", { taskIds: tasks.map((t) => t.id).slice(0, 5) });

    // Use the same sophisticated ID matching logic as getTask
    let taskIndex = -1;

    taskIndex = tasks.findIndex((task) => {
      // Exact match first
      if (task.id === id) return true;

      // Extract local IDs for comparison
      const taskLocalId = task.id.includes("#") ? task.id.split("#").pop() : task.id;
      const searchLocalId = id.includes("#") ? id.split("#").pop() : id;

      // Compare local IDs (e.g., "update-test" vs "update-test")
      if (taskLocalId === searchLocalId) return true;

      // Handle # prefix variations for legacy compatibility
      if (!/^#/.test(id) && task.id === `#${id}`) return true;
      if (id.startsWith("#") && task.id === id.substring(1)) return true;

      return false;
    });

    log.debug("findIndex result", { searchId: id, taskIndex, found: taskIndex !== -1 });

    if (taskIndex === -1) {
      throw new Error(`Task ${id} not found`);
    }

    tasks[taskIndex].status = status;
    await this.saveTasks(tasks);
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    log.debug("markdownTaskBackend updateTask called", { taskId, updates });

    // Get current task data
    const currentTask = await this.getTask(taskId);
    if (!currentTask) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get tasks data to update all fields together (more reliable than separate calls)
    const result = await this.getTasksData();
    if (!result.success || !result.content) {
      throw new Error("Failed to read tasks data");
    }

    const tasks = this.parseTasks(result.content);

    // Find the task to update using the same logic as getTask
    let taskIndex = tasks.findIndex((task) => {
      // Exact match first
      if (task.id === taskId) return true;

      // Extract local IDs for comparison
      const taskLocalId = task.id.includes("#") ? task.id.split("#").pop() : task.id;
      const searchLocalId = taskId.includes("#") ? taskId.split("#").pop() : taskId;

      // Compare local IDs
      if (taskLocalId === searchLocalId) return true;

      // Handle # prefix variations for legacy compatibility
      if (!/^#/.test(taskId) && task.id === `#${taskId}`) return true;
      if (taskId.startsWith("#") && task.id === taskId.substring(1)) return true;

      return false;
    });

    if (taskIndex === -1) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Update the task with provided updates
    const updatedTask = {
      ...tasks[taskIndex],
      ...updates,
      id: tasks[taskIndex].id, // Preserve original ID
    };

    tasks[taskIndex] = updatedTask;

    // Save updated tasks
    const formattedContent = this.formatTasks(tasks);
    const writeResult = await this.saveTasksData(formattedContent);

    if (!writeResult.success) {
      throw new Error(`Failed to save tasks: ${writeResult.error?.message}`);
    }

    // Return the updated task in the expected format
    return {
      id: updatedTask.id,
      title: updatedTask.title,
      description: updatedTask.description || "",
      status: updatedTask.status,
      specPath: updatedTask.specPath || "",
    };
  }

  async createTask(specPath: string | any, _options?: CreateTaskOptions): Promise<Task> {
    // Set up git operations for stash/commit/push flow (reuse setTaskStatus logic)
    const gitService = this.gitService;
    let hasStashedChanges = false;

    try {
      // Check for uncommitted changes and stash them
      const workdir = this.getWorkspacePath();
      const hasUncommittedChanges = await gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges) {
        log.cli("📦 Stashing uncommitted changes...");
        log.debug("Stashing uncommitted changes before task creation", { workdir });

        const stashResult = await gitService.stashChanges(workdir);
        hasStashedChanges = stashResult.stashed;

        if (hasStashedChanges) {
          log.cli("✅ Changes stashed successfully");
        }
        log.debug("Changes stashed", { stashed: hasStashedChanges });
      }
    } catch (statusError) {
      log.debug("Could not check/stash git status before task creation", {
        error: statusError,
      });
    }

    try {
      // Handle both string paths and object parameters for multi-backend compatibility
      const gitService = this.gitService;
      let hasStashedChanges = false;
      try {
        const workdir = this.getWorkspacePath();
        const hasUncommittedChanges = await gitService.hasUncommittedChanges(workdir);
        if (hasUncommittedChanges) {
          log.cli("📦 Stashing uncommitted changes...");
          const stashResult = await gitService.stashChanges(workdir);
          hasStashedChanges = stashResult.stashed;
          if (hasStashedChanges) {
            log.cli("✅ Changes stashed successfully");
          }
        }
      } catch (_e) {
        // Ignore stash pre-check errors
      }
      if (typeof specPath === "object" && specPath.title) {
        // Called with TaskSpec object like createTask({ title: "...", description: "..." })
        // Create task directly without temp files for multi-backend compatibility
        const spec = {
          title: specPath.title,
          description: specPath.description || "",
          id: specPath.id,
        };

        // Get existing tasks from central file to determine new ID
        const existingTasksResult = await this.getTasksData();

        // Handle empty or missing central tasks file gracefully
        let existingTasks: TaskData[] = [];
        if (existingTasksResult.success && existingTasksResult.content) {
          existingTasks = this.parseTasks(existingTasksResult.content);
        }
        const maxId = existingTasks.reduce((max, task) => {
          // Use the new utility to extract numeric value from any format
          const id = getTaskIdNumber(task.id);
          return id !== null && id > max ? id : max;
        }, 0);

        // Extract local ID from qualified ID for backend storage
        let localId: string;
        if (spec.id) {
          // If spec.id is qualified (md#123), extract local part (123)
          if (spec.id.includes("#")) {
            localId = spec.id.split("#")[1];
          } else {
            // Plain ID, use as-is
            localId = spec.id;
          }
        } else {
          // Generate new local ID
          localId = `${maxId + 1}`;
        }

        // Store local ID in backend (multi-backend system handles qualified routing)

        // Create the new task directly
        const newTaskData: TaskData = {
          id: localId,
          title: spec.title,
          description: spec.description,
          status: TASK_STATUS.TODO,
          specPath: "", // No spec file for object-created tasks
        };

        // Update tasks list
        existingTasks.push(newTaskData);
        const formattedContent = this.formatTasks(existingTasks);
        const writeResult = await this.saveTasksData(formattedContent);

        if (!writeResult.success) {
          throw new Error(`Failed to save tasks: ${writeResult.error?.message}`);
        }
        // Commit and push changes
        try {
          const workdir = this.getWorkspacePath();
          const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
          if (hasChangesToCommit) {
            log.cli("💾 Committing task creation...");
            await gitService.execInRepository(workdir, "git add -A");
            const qualifiedId = /^(md#|#)/.test(newTaskData.id)
              ? newTaskData.id.startsWith("#")
                ? `md${newTaskData.id}`
                : newTaskData.id
              : `md#${newTaskData.id}`;
            const commitMessage = `chore(task): create ${qualifiedId} ${spec.title}`;
            await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);
            log.cli("📤 Pushing changes...");
            await gitService.execInRepository(workdir, "git push");
            log.cli("✅ Changes committed and pushed successfully");
          }
        } catch (commitError) {
          log.warn("Failed to commit task creation", { error: commitError });
        } finally {
          if (hasStashedChanges) {
            try {
              log.cli("📂 Restoring stashed changes...");
              await gitService.popStash(this.getWorkspacePath());
              log.cli("✅ Stashed changes restored successfully");
            } catch (popErr) {
              log.debug("Failed to restore stashed changes after creation", {
                error: getErrorMessage(popErr as any),
              });
            }
          }
        }

        // Commit and push the changes (reuse status set commit/push flow)
        try {
          const workdir = this.getWorkspacePath();
          const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
          if (hasChangesToCommit) {
            log.cli("💾 Committing task creation...");

            // Stage all changes
            await gitService.execInRepository(workdir, "git add -A");

            // Use qualified ID in commit message
            const qualifiedId = /^(md#|#)/.test(newTaskData.id)
              ? newTaskData.id.startsWith("#")
                ? `md${newTaskData.id}`
                : newTaskData.id
              : `md#${newTaskData.id}`;
            const commitMessage = `chore(task): create ${qualifiedId} ${spec.title}`;
            await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);

            log.cli("📤 Pushing changes...");
            await gitService.execInRepository(workdir, "git push");

            log.cli("✅ Changes committed and pushed successfully");
            log.debug("Task creation committed and pushed", {
              taskId: qualifiedId,
              title: spec.title,
            });
          }
        } catch (commitError) {
          log.warn("Failed to commit task creation", {
            taskId: newTaskData.id,
            error: commitError,
          });
          log.cli(`⚠️ Warning: Failed to commit changes: ${commitError}`);
        }

        const newTask: Task = {
          id: newTaskData.id,
          title: newTaskData.title,
          description: newTaskData.description,
          status: newTaskData.status,
          specPath: newTaskData.specPath,
        };

        return newTask;
      }

      // Original string path behavior
      // Read and parse the spec file
      const specResult = await this.getTaskSpecData(specPath as string);
      if (!specResult.success || !specResult.content) {
        throw new Error(`Failed to read spec file: ${specPath}`);
      }

      const spec = this.parseTaskSpec(specResult.content);

      // Get existing tasks from central file to determine new ID
      const existingTasksResult = await this.getTasksData();

      // Handle empty or missing central tasks file gracefully
      let existingTasks: TaskData[] = [];
      if (existingTasksResult.success && existingTasksResult.content) {
        existingTasks = this.parseTasks(existingTasksResult.content);
      }
      const maxId = existingTasks.reduce((max, task) => {
        // Use the new utility to extract numeric value from any format
        const id = getTaskIdNumber(task.id);
        return id !== null && id > max ? id : max;
      }, 0);

      // Generate qualified backend ID for multi-backend storage (e.g., "md#285")
      const newId = `md#${maxId + 1}`; // Qualified format for storage

      // Generate proper spec path and move the temporary file
      // Use display format for spec path generation since filenames use display format
      const displayId = formatTaskIdForDisplay(newId);
      const properSpecPath = getTaskSpecRelativePath(displayId, spec.title, this.workspacePath);
      const fullProperPath = join(this.workspacePath, properSpecPath);

      // Ensure the tasks directory exists
      const tasksDir = dirname(fullProperPath);
      try {
        await fs.mkdir(tasksDir, { recursive: true });
      } catch (error) {
        // Directory already exists, continue
      }

      // Move the temporary file to the proper location
      try {
        // Read the spec file content
        const specContent = await fs.readFile(specPath, "utf-8");
        // Write to the proper location
        await fs.writeFile(fullProperPath, specContent, "utf-8");
        // Delete the temporary file
        try {
          await fs.unlink(specPath);
        } catch (error) {
          // Ignore cleanup errors
        }
      } catch (error) {
        throw new Error(
          `Failed to move spec file from ${specPath} to ${properSpecPath}: ${getErrorMessage(error)}`
        );
      }

      const newTaskData: TaskData = {
        id: newId,
        title: spec.title,
        description: spec.description,
        status: "TODO" as TaskStatus,
        specPath: properSpecPath,
      };

      // Add the new task to the list
      existingTasks.push(newTaskData);
      const updatedContent = this.formatTasks(existingTasks);

      const saveResult = await this.saveTasksData(updatedContent);
      if (!saveResult.success) {
        throw new Error(`Failed to save tasks: ${saveResult.error?.message}`);
      }
      // Commit and push changes
      try {
        const workdir = this.getWorkspacePath();
        const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
        if (hasChangesToCommit) {
          log.cli("💾 Committing task creation...");
          await gitService.execInRepository(workdir, "git add -A");
          const commitMessage = `chore(task): create ${newTaskData.id} ${spec.title}`;
          await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);
          log.cli("📤 Pushing changes...");
          await gitService.execInRepository(workdir, "git push");
          log.cli("✅ Changes committed and pushed successfully");
        }
      } catch (commitError) {
        log.warn("Failed to commit task creation", { error: commitError });
      } finally {
        if (hasStashedChanges) {
          try {
            log.cli("📂 Restoring stashed changes...");
            await gitService.popStash(this.getWorkspacePath());
            log.cli("✅ Stashed changes restored successfully");
          } catch (popErr) {
            log.debug("Failed to restore stashed changes after creation", {
              error: getErrorMessage(popErr as any),
            });
          }
        }
      }

      // Commit and push the changes (reuse status set commit/push flow)
      try {
        const workdir = this.getWorkspacePath();
        const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
        if (hasChangesToCommit) {
          log.cli("💾 Committing task creation...");

          // Stage all changes
          await gitService.execInRepository(workdir, "git add -A");

          const commitMessage = `chore(task): create ${newTaskData.id} ${spec.title}`;
          await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);

          log.cli("📤 Pushing changes...");
          await gitService.execInRepository(workdir, "git push");

          log.cli("✅ Changes committed and pushed successfully");
          log.debug("Task creation committed and pushed", {
            taskId: newTaskData.id,
            title: spec.title,
          });
        }
      } catch (commitError) {
        log.warn("Failed to commit task creation", {
          taskId: newTaskData.id,
          error: commitError,
        });
        log.cli(`⚠️ Warning: Failed to commit changes: ${commitError}`);
      }

      // Convert TaskData to Task for return
      const newTask: Task = {
        id: newTaskData.id,
        title: newTaskData.title,
        description: newTaskData.description,
        status: newTaskData.status,
        specPath: newTaskData.specPath,
      };

      return newTask;
    } finally {
      // Restore stashed changes if we stashed them
      if (hasStashedChanges) {
        try {
          log.cli("📂 Restoring stashed changes...");
          log.debug("Restoring stashed changes after task creation");

          const workdir = this.getWorkspacePath();
          await gitService.popStash(workdir);

          log.cli("✅ Stashed changes restored successfully");
          log.debug("Stashed changes restored");
        } catch (popError) {
          log.warn("Failed to restore stashed changes", {
            error: popError,
          });
          log.cli(`⚠️ Warning: Failed to restore stashed changes: ${popError}`);
        }
      }
    }
  }

  /**
   * Create a new task from title and description
   * @param title Title of the task
   * @param description Description of the task
   * @param options Options for creating the task
   * @returns Promise resolving to the created task
   */
  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    const id = this.generateTaskId(title);
    const specPath = this.buildSpecPath(id, title);
    // Write the spec content directly instead of generating a template
    const specContent = spec;

    // Create directory if it doesn't exist
    const specDir = dirname(specPath);
    if (!(await this.fileExists(specDir))) {
      await mkdir(specDir, { recursive: true });
    }

    // Write spec file
    await writeFile(specPath, specContent, "utf-8");

    // Create task object
    const task: Task = {
      id,
      title,
      status: "TODO",
      specPath,
    };

    // Update tasks list
    await this.updateTasksFile([task]);

    return task;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const tasks = await this.parseTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      return false;
    }

    const task = tasks[taskIndex];
    tasks.splice(taskIndex, 1);

    // Delete spec file if it exists
    if (task.specPath && (await this.fileExists(task.specPath))) {
      await fs.unlink(task.specPath);
    }

    await this.saveTasks(tasks);
    return true;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCapabilities(): BackendCapabilities {
    return {
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canList: true,
      supportsMetadata: false,
      supportsSearch: false,
    };
  }

  // ---- Optional Metadata Methods ----

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    const task = await this.getTask(id);
    if (!task || !task.specPath) {
      return null;
    }

    try {
      const content = await fs.readFile(task.specPath, "utf-8");
      return {
        id: task.id,
        title: task.title,
        spec: content,
        status: task.status,
        backend: task.backend,
        createdAt: undefined, // Not available in markdown format
        updatedAt: undefined,
      };
    } catch {
      return null;
    }
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    // Update task entry
    const tasks = await this.parseTasks();
    const taskIndex = tasks.findIndex((task) => task.id === id);

    if (taskIndex === -1) {
      throw new Error(`Task ${id} not found`);
    }

    tasks[taskIndex].title = metadata.title;
    tasks[taskIndex].status = metadata.status;

    // Update spec file
    if (metadata.spec && tasks[taskIndex].specPath) {
      await fs.writeFile(tasks[taskIndex].specPath, metadata.spec);
    }

    await this.saveTasks(tasks);
  }

  // ---- Internal Methods ----

  private async parseTasks(): Promise<Task[]> {
    try {
      const content = String(await fs.readFile(this.filePath, "utf-8"));
      const lines = content.toString().split("\n");
      const tasks: Task[] = [];
      let inCodeBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim().startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (inCodeBlock) continue;

        const parsed = TASK_PARSING_UTILS.parseTaskLine(line);
        if (!parsed) continue;

        const { checkbox, title, id } = parsed;
        if (!title || !id || !/^(#\d+|[a-z-]+#\d+)$/.test(id)) continue;

        const status = Object.keys(TASK_STATUS_CHECKBOX).find(
          (key) => TASK_STATUS_CHECKBOX[key] === checkbox
        );
        if (!status) continue;

        const specPath = await this.validateSpecPath(id, title);

        // Collect description from indented lines
        let description: string | undefined = undefined;
        const descriptionLines: string[] = [];

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j] ?? "";
          if (nextLine.trim() === "") {
            if (descriptionLines.length > 0) break;
            continue;
          }
          if (!nextLine.startsWith("  ") && !nextLine.startsWith("\t")) break;

          const content = nextLine.replace(/^[\s\t]+/, "");
          if (content.trim()) {
            descriptionLines.push(content);
          }
        }

        if (descriptionLines.length > 0) {
          description = descriptionLines.join(" ").trim();
        }

        tasks.push({
          id,
          title,
          description: description || "",
          status,
          specPath,
          backend: "markdown",
        });
      }

      return tasks;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async saveTasks(tasks: Task[]): Promise<void> {
    const content = this.formatTasks(tasks);
    await fs.writeFile(this.filePath, content);
  }

  private formatTasks(tasks: Task[]): string {
    if (tasks.length === 0) {
      return "# Tasks\n\n(No tasks yet)\n";
    }

    const lines = ["# Tasks", ""];

    for (const task of tasks) {
      const checkbox = TASK_STATUS_CHECKBOX[task.status] || "☐";
      lines.push(`${checkbox} ${task.title} ${task.id}`);

      if (task.description) {
        const descLines = task.spec.split("\n");
        for (const descLine of descLines) {
          if (descLine.trim()) {
            lines.push(`  ${descLine.trim()}`);
          }
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private async validateSpecPath(taskId: string, title: string): Promise<string | undefined> {
    const specPath = this.getTaskSpecPath(taskId, title);
    if (await this.fileExists(specPath)) {
      return specPath;
    }
    return undefined;
  }

  private getTaskSpecPath(taskId: string, title: string): string {
    const cleanId = taskId.replace(/^(md)?#/, "");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 50);

    return path.join(this.workspacePath, "process", "tasks", `${cleanId}-${slug}.md`);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a new MarkdownTaskBackend
 * @param config Backend configuration
 * @returns MarkdownTaskBackend instance
 */
export function createMarkdownTaskBackend(config: TaskBackendConfig): TaskBackend {
  return new MarkdownTaskBackend(config);
}
