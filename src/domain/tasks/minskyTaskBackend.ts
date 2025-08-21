import { eq, not, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
// Remove configuration import - dependencies should be injected
import {
  tasksTable,
  taskSpecsTable,
  tasksEmbeddingsTable,
} from "../storage/schemas/task-embeddings";
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
import * as crypto from "crypto";

export interface MinskyTaskBackendConfig extends TaskBackendConfig {
  db: PostgresJsDatabase;
}

export class MinskyTaskBackend implements TaskBackend {
  name = "minsky";
  private readonly db: PostgresJsDatabase;
  private readonly workspacePath: string;

  constructor(config: MinskyTaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.db = config.db; // Database connection injected as dependency
  }

  // Database connection is now injected - no need for createDbConnection method

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    let query = this.db.select().from(tasksTable);

    const conditions = [];

    if (options?.status && options.status !== "all") {
      conditions.push(eq(tasksTable.status, options.status as any));
    } else if (!options?.all) {
      // Default: exclude DONE and CLOSED tasks unless --all is specified
      conditions.push(not(eq(tasksTable.status, "DONE")));
      conditions.push(not(eq(tasksTable.status, "CLOSED")));
    }

    // NOTE: Filter by backend to only show Minsky-native tasks (backend="minsky")
    conditions.push(eq(tasksTable.backend, "minsky"));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const rows = await query;
    return rows.map((row) => this.mapDbRowToTask(row));
  }
  async getTask(id: string): Promise<Task | null> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);

    if (rows.length === 0) {
      return null;
    }

    return this.mapDbRowToTask(rows[0]);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({
        status: status as any,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id));
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    const id = this.generateTaskId(title);
    const task: Task = {
      id,
      title,
      status: "TODO",
      backend: this.name,
    };

    // Save task metadata to tasks table
    await this.db.insert(tasksTable).values({
      id,
      sourceTaskId: id.split("#")[1], // Extract the numeric part
      backend: "minsky" as const,
      status: "TODO" as const,
      title,
      contentHash: this.generateContentHash(title + spec),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Save spec content to task_specs table
    await this.db.insert(taskSpecsTable).values({
      taskId: id,
      content: spec, // Use the spec content directly
      contentHash: this.generateContentHash(spec),
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return task;
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const result = await this.db.delete(tasksTable).where(eq(tasksTable.id, id));
    return (result as any).rowCount > 0;
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
    };
  }

  // ---- Optional Metadata Methods ----

  async getTaskMetadata(id: string): Promise<TaskMetadata | null> {
    const task = await this.getTask(id);
    if (!task) {
      return null;
    }

    // Get spec content
    const specRows = await this.db
      .select()
      .from(taskSpecsTable)
      .where(eq(taskSpecsTable.taskId, id))
      .limit(1);

    const spec = specRows.length > 0 ? specRows[0].content : "";

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

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    // Update task metadata
    await this.db
      .update(tasksTable)
      .set({
        title: metadata.title,
        status: metadata.status as any,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id));

    // Update spec content if provided
    if (metadata.spec) {
      await this.db
        .update(taskSpecsTable)
        .set({
          content: metadata.spec,
          contentHash: this.generateContentHash(metadata.spec),
          updatedAt: new Date(),
        })
        .where(eq(taskSpecsTable.taskId, id));
    }
  }

  // ---- Private Helper Methods ----

  private mapDbRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      backend: this.name,
    };
  }

  private generateTaskId(title: string): string {
    // Generate a simple incrementing ID - in production you'd want something more robust
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `mt#${timestamp}-${random}`;
  }

  private generateContentHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }
}

// Factory function - now requires database connection
export function createMinskyTaskBackend(config: MinskyTaskBackendConfig): MinskyTaskBackend {
  return new MinskyTaskBackend(config);
}
