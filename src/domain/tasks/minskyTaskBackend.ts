import { eq, not, and, like, inArray, type SQL } from "drizzle-orm";
import { TaskStatus } from "./taskConstants";
// Remove configuration import - dependencies should be injected
import { tasksTable, taskSpecsTable } from "../storage/schemas/task-embeddings";
import { first } from "../../utils/array-safety";
import type {
  Task,
  TaskBackend,
  TaskBackendConfig,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  BackendCapabilities,
  TaskMetadata,
} from "./types";

/**
 * Narrow interface covering only the Drizzle DB methods used by MinskyTaskBackend.
 * Using `any` return types lets test fakes satisfy this interface without
 * needing `as unknown as` casts, while the real PostgresJsDatabase satisfies
 * it structurally.
 */

export interface MinskyBackendDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(fields?: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: any): any;
}

export interface MinskyTaskBackendConfig extends TaskBackendConfig {
  db: MinskyBackendDb;
}

export class MinskyTaskBackend implements TaskBackend {
  name = "minsky";
  prefix?: string;
  private readonly db: MinskyBackendDb;
  private readonly workspacePath: string;

  constructor(config: MinskyTaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.db = config.db; // Database connection injected as dependency
  }

  // Database connection is now injected - no need for createDbConnection method

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const conditions: SQL[] = [];

    if (options?.status && options.status !== "all") {
      conditions.push(eq(tasksTable.status, options.status));
    } else if (!options?.all) {
      // Default: exclude DONE and CLOSED tasks unless --all is specified
      conditions.push(not(eq(tasksTable.status, "DONE")));
      conditions.push(not(eq(tasksTable.status, "CLOSED")));
    }

    // NOTE: Filter by backend to only show Minsky-native tasks (backend="minsky")
    conditions.push(eq(tasksTable.backend, "minsky"));

    // Filter by tags if specified
    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        conditions.push(like(tasksTable.tags, `%"${tag}"%`));
      }
    }

    const query = this.db.select().from(tasksTable);
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
    return rows.map((row) => this.mapDbRowToTask(row));
  }
  async getTask(id: string): Promise<Task | null> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);

    if (rows.length === 0 || !rows[0]) {
      return null;
    }

    return this.mapDbRowToTask(rows[0]);
  }

  async getTasks(ids: string[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(tasksTable).where(inArray(tasksTable.id, ids));
    return rows.map((row) => this.mapDbRowToTask(row));
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({
        status: status as (typeof TaskStatus)[keyof typeof TaskStatus],
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id));
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // If an explicit id is provided, use it directly (no retry needed).
    if (options?.id) {
      return this.insertTaskWithId(options.id, title, spec, options);
    }

    // Retry loop to handle the TOCTOU race between generateTaskId and INSERT.
    // generateTaskId reads max(id) and proposes maxId+1, but another concurrent
    // writer may have claimed that id between the SELECT and our INSERT.
    // onConflictDoNothing makes the INSERT a no-op on collision so we can detect
    // it and try the next id rather than silently clobbering existing data.
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const id = await this.generateTaskId(title);
      const inserted = await this.tryInsertTask(id, title, spec, options);
      if (inserted) {
        const tags = options?.tags || [];
        return { id, title, status: "TODO", backend: this.name, tags };
      }
      // id collision — another writer took this id; loop and re-generate
    }

    throw new Error(
      `Failed to generate a unique task id after ${MAX_RETRIES} attempts. ` +
        "This indicates extremely high concurrent task creation — please retry."
    );
  }

  /**
   * Attempt to insert a task row. Returns true if the row was inserted,
   * false if the id already exists (conflict).
   * Never overwrites existing data (onConflictDoNothing).
   */
  private async tryInsertTask(
    id: string,
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<boolean> {
    const tags = options?.tags || [];

    // Insert task metadata row; do nothing on id conflict
    const inserted = await this.db
      .insert(tasksTable)
      .values({
        id,
        sourceTaskId: id.split("#")[1], // Extract the numeric part
        backend: "minsky" as const,
        status: (options?.status || "TODO") as (typeof TaskStatus)[keyof typeof TaskStatus],
        title,
        tags: JSON.stringify(tags),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: tasksTable.id });

    if (inserted.length === 0) {
      // Conflict — the id was already taken
      return false;
    }

    // Insert spec content; do nothing on taskId conflict (same safety net)
    await this.db
      .insert(taskSpecsTable)
      .values({
        taskId: id,
        content: spec,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    return true;
  }

  /**
   * Insert a task with a caller-supplied id (used when options.id is set).
   * Uses onConflictDoNothing on the task row to avoid clobbering and throws
   * if the id is already taken.
   */
  private async insertTaskWithId(
    id: string,
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    const tags = options?.tags || [];

    const inserted = await this.db
      .insert(tasksTable)
      .values({
        id,
        sourceTaskId: id.split("#")[1],
        backend: "minsky" as const,
        status: (options?.status || "TODO") as (typeof TaskStatus)[keyof typeof TaskStatus],
        title,
        tags: JSON.stringify(tags),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: tasksTable.id });

    if (inserted.length === 0) {
      throw new Error(
        `Task id "${id}" already exists. Use a different id or omit it to auto-generate.`
      );
    }

    await this.db
      .insert(taskSpecsTable)
      .values({
        taskId: id,
        content: spec,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    return { id, title, status: "TODO", backend: this.name, tags };
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const deleted = await this.db
      .delete(tasksTable)
      .where(eq(tasksTable.id, id))
      .returning({ id: tasksTable.id });
    return deleted.length > 0;
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
      supportsMetadata: true,
      supportsSearch: true,
      supportsTags: true,
    };
  }

  // ---- Optional Metadata Methods ----

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    // Get spec content
    const specRows = (await this.db
      .select()
      .from(taskSpecsTable)
      .where(eq(taskSpecsTable.taskId, id))
      .limit(1)) as Array<{ content: string }>;

    const spec = specRows.length > 0 ? first(specRows, "task spec query").content : "";

    return {
      id: task.id,
      title: task.title,
      spec,
      status: task.status,
      backend: task.backend || this.name,
      createdAt: undefined,
      updatedAt: undefined,
    };
  }

  async updateTags(id: string, tags: string[]): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({
        tags: JSON.stringify(tags),
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id));
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    // Update task metadata
    await this.db
      .update(tasksTable)
      .set({
        title: metadata.title,
        status: metadata.status as (typeof TaskStatus)[keyof typeof TaskStatus],
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id));

    // Update spec content if provided
    if (metadata.spec) {
      await this.db
        .update(taskSpecsTable)
        .set({
          content: metadata.spec,
          updatedAt: new Date(),
        })
        .where(eq(taskSpecsTable.taskId, id));
    }
  }

  async getTaskSpecContent(
    taskId: string,
    section?: string
  ): Promise<{ task: Task; specPath: string; content: string; section?: string }> {
    // Get the task first
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get spec content from database
    const specRows = (await this.db
      .select()
      .from(taskSpecsTable)
      .where(eq(taskSpecsTable.taskId, taskId))
      .limit(1)) as Array<{ content: string }>;

    const content = specRows.length > 0 ? first(specRows, "task spec content query").content : "";

    return {
      task,
      specPath: "", // Minsky backend doesn't use file paths
      content,
      section,
    };
  }

  // ---- Private Helper Methods ----

  private mapDbRowToTask(row: {
    id: string;
    title: string | null;
    status: string | null;
    tags?: string | null;
  }): Task {
    let tags: string[] = [];
    if (row.tags) {
      try {
        tags = JSON.parse(row.tags);
      } catch {
        tags = [];
      }
    }
    return {
      id: row.id,
      title: row.title ?? "",
      status: row.status ?? "TODO",
      backend: this.name,
      tags,
    };
  }

  private async generateTaskId(_title: string): Promise<string> {
    // Fetch all mt# task ids and compute max numerically.
    // We cannot use a DB-level SERIAL here because ids are stored as strings
    // (e.g. "mt#123"), so we perform a lightweight SELECT of ids only and
    // derive the next number in application code.
    // Race safety: the caller (createTaskFromTitleAndSpec) uses onConflictDoNothing
    // + a retry loop so a concurrent writer claiming this id is detected and
    // handled without silently clobbering existing data.
    const rows = await this.db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(like(tasksTable.id, "mt#%"));

    const maxId = rows.reduce((acc, row) => {
      const num = parseInt(row.id.replace("mt#", ""), 10);
      return !isNaN(num) && num > acc ? num : acc;
    }, 0);

    return `mt#${maxId + 1}`;
  }
}

// Factory function - now requires database connection
export function createMinskyTaskBackend(config: MinskyTaskBackendConfig): MinskyTaskBackend {
  return new MinskyTaskBackend(config);
}
