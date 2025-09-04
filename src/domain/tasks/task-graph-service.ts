import { and, eq, sql, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { taskRelationshipsTable } from "../storage/schemas/task-relationships";

function isQualifiedId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.includes("#") &&
    id.split("#")[0].length > 0 &&
    id.split("#")[1].length > 0
  );
}

interface TaskRelationshipsRepository {
  findEdge(fromId: string, toId: string): Promise<boolean>;
  createEdge(fromId: string, toId: string): Promise<void>;
  deleteEdge(fromId: string, toId: string): Promise<number>;
  listFrom(taskId: string): Promise<string[]>;
  listTo(taskId: string): Promise<string[]>;
  // Bulk operations for efficient graph building
  getAllRelationships(): Promise<{ fromTaskId: string; toTaskId: string }[]>;
  getRelationshipsForTasks(taskIds: string[]): Promise<{ fromTaskId: string; toTaskId: string }[]>;
}

function createDrizzleRepo(db: PostgresJsDatabase): TaskRelationshipsRepository {
  return {
    async findEdge(fromId, toId) {
      const existing = await db
        .select({ id: taskRelationshipsTable.id })
        .from(taskRelationshipsTable)
        .where(
          and(
            eq(taskRelationshipsTable.fromTaskId, fromId),
            eq(taskRelationshipsTable.toTaskId, toId)
          )
        )
        .limit(1);
      return existing.length > 0;
    },
    async createEdge(fromId, toId) {
      await db.insert(taskRelationshipsTable).values({ fromTaskId: fromId, toTaskId: toId });
    },
    async deleteEdge(fromId, toId) {
      const res = await db
        .delete(taskRelationshipsTable)
        .where(
          and(
            eq(taskRelationshipsTable.fromTaskId, fromId),
            eq(taskRelationshipsTable.toTaskId, toId)
          )
        );
      return (res as any)?.rowCount ?? 0;
    },
    async listFrom(taskId) {
      const rows = await db
        .select({ to: taskRelationshipsTable.toTaskId })
        .from(taskRelationshipsTable)
        .where(eq(taskRelationshipsTable.fromTaskId, taskId));
      return rows.map((r) => r.to);
    },
    async listTo(taskId) {
      const rows = await db
        .select({ from: taskRelationshipsTable.fromTaskId })
        .from(taskRelationshipsTable)
        .where(eq(taskRelationshipsTable.toTaskId, taskId));
      return rows.map((r) => r.from);
    },
    async getAllRelationships() {
      const rows = await db
        .select({
          fromTaskId: taskRelationshipsTable.fromTaskId,
          toTaskId: taskRelationshipsTable.toTaskId,
        })
        .from(taskRelationshipsTable);
      return rows;
    },
    async getRelationshipsForTasks(taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await db
        .select({
          fromTaskId: taskRelationshipsTable.fromTaskId,
          toTaskId: taskRelationshipsTable.toTaskId,
        })
        .from(taskRelationshipsTable)
        .where(
          or(
            inArray(taskRelationshipsTable.fromTaskId, taskIds),
            inArray(taskRelationshipsTable.toTaskId, taskIds)
          )
        );
      return rows;
    },
  };
}

export class TaskGraphService {
  private readonly repo: TaskRelationshipsRepository;

  // Accept either a Drizzle database or a repository implementation
  constructor(dbOrRepo: PostgresJsDatabase | TaskRelationshipsRepository) {
    this.repo =
      typeof (dbOrRepo as any).select === "function"
        ? createDrizzleRepo(dbOrRepo as PostgresJsDatabase)
        : (dbOrRepo as TaskRelationshipsRepository);
  }

  async addDependency(fromId: string, toId: string): Promise<{ created: boolean }> {
    if (!isQualifiedId(fromId) || !isQualifiedId(toId)) {
      throw new Error("Invalid task ID format; use qualified IDs like md#123");
    }
    if (fromId === toId) {
      throw new Error("A task cannot depend on itself");
    }

    const exists = await this.repo.findEdge(fromId, toId);
    if (exists) {
      return { created: false };
    }
    await this.repo.createEdge(fromId, toId);
    return { created: true };
  }

  async removeDependency(fromId: string, toId: string): Promise<{ removed: boolean }> {
    const count = await this.repo.deleteEdge(fromId, toId);
    return { removed: count > 0 };
  }

  async listDependencies(taskId: string): Promise<string[]> {
    return this.repo.listFrom(taskId);
  }

  async listDependents(taskId: string): Promise<string[]> {
    return this.repo.listTo(taskId);
  }

  /**
   * Get all relationships at once - efficient for graph visualization
   */
  async getAllRelationships(): Promise<{ fromTaskId: string; toTaskId: string }[]> {
    return this.repo.getAllRelationships();
  }

  /**
   * Get relationships for a specific set of tasks - efficient for filtered graphs
   */
  async getRelationshipsForTasks(
    taskIds: string[]
  ): Promise<{ fromTaskId: string; toTaskId: string }[]> {
    return this.repo.getRelationshipsForTasks(taskIds);
  }
}
