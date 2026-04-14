/**
 * FakeTaskService — in-memory test double for TaskServiceInterface.
 *
 * Follows the canonical FakeX pattern established in
 * `src/domain/persistence/fake-persistence-provider.ts`: a real class
 * implementing the typed DI interface, holding state in memory, with
 * zero external I/O.
 *
 * Hermetic by construction: no filesystem, no DB, no network.
 *
 * Default behavior mirrors the former `createMockTaskService` factory
 * from `src/utils/test-utils/dependencies.ts` (now deleted):
 *   - getTask → null
 *   - listTasks → []
 *   - getTaskStatus → undefined
 *   - setTaskStatus → no-op
 *   - createTask → { id: "#fake-1", title: "Fake Task", status: "TODO" }
 *   - createTaskFromTitleAndSpec → stores task and returns it
 *   - deleteTask → false (task not in store)
 *   - getWorkspacePath → "/fake/workspace"
 *   - getBackendForTask → "minsky"
 *
 * @see src/domain/persistence/fake-persistence-provider.ts
 */

import type { Task, TaskListOptions, CreateTaskOptions, DeleteTaskOptions } from "./types";
import type { TaskServiceInterface } from "./taskService";

export class FakeTaskService implements TaskServiceInterface {
  private readonly tasks = new Map<string, Task>();
  private readonly workspacePath: string;
  private nextTaskId = 1;

  constructor(
    options: {
      initialTasks?: Task[];
      workspacePath?: string;
    } = {}
  ) {
    this.workspacePath = options.workspacePath ?? "/fake/workspace";
    for (const task of options.initialTasks ?? []) {
      this.tasks.set(task.id, task);
    }
  }

  async listTasks(_options?: TaskListOptions): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async getTaskStatus(taskId: string): Promise<string | undefined> {
    return this.tasks.get(taskId)?.status;
  }

  async setTaskStatus(taskId: string, status: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.set(taskId, { ...task, status });
    }
  }

  async createTask(_specPath: string, _options?: CreateTaskOptions): Promise<Task> {
    const id = `#fake-${this.nextTaskId++}`;
    const task: Task = { id, title: "Fake Task", status: "TODO" };
    this.tasks.set(id, task);
    return task;
  }

  async createTaskFromTitleAndSpec(
    title: string,
    _spec: string,
    _options?: CreateTaskOptions
  ): Promise<Task> {
    const id = `#fake-${this.nextTaskId++}`;
    const task: Task = { id, title, status: "TODO" };
    this.tasks.set(id, task);
    return task;
  }

  async deleteTask(taskId: string, _options?: DeleteTaskOptions): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  async getTaskSpecContent(
    taskId: string,
    section?: string
  ): Promise<{ task: Task; specPath: string; content: string; section?: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return {
      task,
      specPath: `${this.workspacePath}/specs/${taskId}.md`,
      content: `# ${task.title}\n`,
      section,
    };
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async getBackendForTask(_taskId: string): Promise<string> {
    return "minsky";
  }
}
