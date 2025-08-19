import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, desc, and, or } from "drizzle-orm";
import { getDb } from "../storage/db";
import { tasksTable, taskSpecsTable } from "../storage/schemas/task-embeddings";
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

export class DatabaseTaskBackend implements TaskBackend {
  name = "db";
  private readonly db: PostgresJsDatabase;
  private readonly workspacePath: string;

  constructor(config: TaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.db = getDb(); // Assuming getDb() provides the Drizzle instance
  }

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const query = this.db.select().from(tasksTable).orderBy(desc(tasksTable.createdAt));

    // Apply filters if provided
    const conditions = [];
    if (options?.status) {
      conditions.push(eq(tasksTable.status, options.status));
    }
    if (options?.backend) {
      conditions.push(eq(tasksTable.backend, options.backend));
    }

    if (conditions.length > 0) {
      query.where(and(...conditions));
    }

    const dbTasks = await query.execute();

    return dbTasks.map(this.mapDbTaskToTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const dbTask = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1)
      .execute();

    if (dbTask.length === 0) {
      return null;
    }

    return this.mapDbTaskToTask(dbTask[0]);
  }

  async getTaskStatus(id: string): Promise<string | undefined> {
    const task = await this.getTask(id);
    return task?.status;
  }

  async setTaskStatus(id: string, status: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, id))
      .execute();
  }

  async createTaskFromTitleAndDescription(
    title: string,
    description: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // Generate next task ID
    const existingTasks = await this.listTasks();
    const maxId = existingTasks.reduce((max, task) => {
      const numId = parseInt(task.id.replace(/^db#/, ""), 10);
      return numId > max ? numId : max;
    }, 0);

    const newId = `db#${maxId + 1}`;
    const now = new Date();

    // Create full spec content
    const specContent = this.generateTaskSpecContent(title, description);

    // Insert task and spec in transaction
    await this.db.transaction(async (tx) => {
      // Insert task metadata
      await tx.insert(tasksTable).values({
        id: newId,
        backend: "db",
        status: "TODO",
        title,
        createdAt: now,
        updatedAt: now,
      });

      // Insert task spec
      await tx.insert(taskSpecsTable).values({
        taskId: newId,
        content: specContent,
        createdAt: now,
        updatedAt: now,
      });
    });

    return {
      id: newId,
      title,
      description,
      status: "TODO",
      specPath: `db:${newId}`,
      backend: "db",
    };
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    const result = await this.db.delete(tasksTable).where(eq(tasksTable.id, id)).execute();

    return result.rowCount > 0;
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
    // Get both task and spec data
    const taskQuery = this.db.select().from(tasksTable).where(eq(tasksTable.id, id)).limit(1);

    const specQuery = this.db
      .select()
      .from(taskSpecsTable)
      .where(eq(taskSpecsTable.taskId, id))
      .limit(1);

    const [taskResult, specResult] = await Promise.all([taskQuery.execute(), specQuery.execute()]);

    if (taskResult.length === 0) {
      return null;
    }

    const task = taskResult[0];
    const spec = specResult[0];

    return {
      id: task.id,
      title: task.title,
      spec: spec?.content || "",
      status: task.status,
      backend: task.backend,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  async setTaskMetadata(id: string, metadata: TaskMetadata): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      // Update task metadata
      await tx
        .update(tasksTable)
        .set({
          title: metadata.title,
          status: metadata.status,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, id));

      // Update or insert spec
      if (metadata.spec) {
        const existing = await tx
          .select()
          .from(taskSpecsTable)
          .where(eq(taskSpecsTable.taskId, id))
          .limit(1);

        if (existing.length > 0) {
          await tx
            .update(taskSpecsTable)
            .set({
              content: metadata.spec,
              updatedAt: now,
            })
            .where(eq(taskSpecsTable.taskId, id));
        } else {
          await tx.insert(taskSpecsTable).values({
            taskId: id,
            content: metadata.spec,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });
  }

  // ---- Internal Helper Methods ----

  private mapDbTaskToTask(dbTask: any): Task {
    return {
      id: dbTask.id,
      title: dbTask.title || "",
      description: "", // Will be extracted from spec if needed
      status: dbTask.status || "TODO",
      specPath: `db:${dbTask.id}`,
      backend: "db",
    };
  }

  private generateTaskSpecContent(title: string, description: string): string {
    return `# ${title}

## Context

${description}

## Requirements

(Requirements to be added)

## Implementation

(Implementation details to be added)
`;
  }
}

export function createDatabaseTaskBackend(config: TaskBackendConfig): DatabaseTaskBackend {
  return new DatabaseTaskBackend(config);
}
