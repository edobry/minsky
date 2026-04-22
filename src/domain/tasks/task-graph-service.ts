import { injectable } from "tsyringe";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { taskRelationshipsTable } from "../storage/schemas/task-relationships";

/** Edge types for task relationships */
export type RelationshipType = "depends" | "parent";

function isQualifiedId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.includes("#") &&
    (id.split("#")[0] ?? "").length > 0 &&
    (id.split("#")[1] ?? "").length > 0
  );
}

function validateQualifiedIds(...ids: string[]): void {
  for (const id of ids) {
    if (!isQualifiedId(id)) {
      throw new Error(`Invalid task ID format "${id}"; use qualified IDs like mt#123`);
    }
  }
}

export interface TaskRelationship {
  fromTaskId: string;
  toTaskId: string;
  type: RelationshipType;
}

interface TaskRelationshipsRepository {
  findEdge(fromId: string, toId: string, type: RelationshipType): Promise<boolean>;
  createEdge(fromId: string, toId: string, type: RelationshipType): Promise<void>;
  deleteEdge(fromId: string, toId: string, type: RelationshipType): Promise<number>;
  deleteEdgesFrom(fromId: string, type: RelationshipType): Promise<number>;
  listFrom(taskId: string, type: RelationshipType): Promise<string[]>;
  listTo(taskId: string, type: RelationshipType): Promise<string[]>;
  getAllRelationships(type?: RelationshipType): Promise<TaskRelationship[]>;
  getRelationshipsForTasks(taskIds: string[], type?: RelationshipType): Promise<TaskRelationship[]>;
  getAncestorChain(taskId: string, maxDepth: number): Promise<string[]>;
  /**
   * Atomically replace the parent edge for a child task.
   * Removes any existing parent edge and inserts the new one in a single operation.
   * Returns the previous parent id, or null if there was none.
   */
  upsertParent(childId: string, newParentId: string): Promise<{ previousParent: string | null }>;
}

function createDrizzleRepo(db: PostgresJsDatabase): TaskRelationshipsRepository {
  return {
    async findEdge(fromId, toId, type) {
      const existing = await db
        .select({ id: taskRelationshipsTable.id })
        .from(taskRelationshipsTable)
        .where(
          and(
            eq(taskRelationshipsTable.fromTaskId, fromId),
            eq(taskRelationshipsTable.toTaskId, toId),
            eq(taskRelationshipsTable.type, type)
          )
        )
        .limit(1);
      return existing.length > 0;
    },
    async createEdge(fromId, toId, type) {
      await db.insert(taskRelationshipsTable).values({ fromTaskId: fromId, toTaskId: toId, type });
    },
    async deleteEdge(fromId, toId, type) {
      const deleted = await db
        .delete(taskRelationshipsTable)
        .where(
          and(
            eq(taskRelationshipsTable.fromTaskId, fromId),
            eq(taskRelationshipsTable.toTaskId, toId),
            eq(taskRelationshipsTable.type, type)
          )
        )
        .returning({ id: taskRelationshipsTable.id });
      return deleted.length;
    },
    async deleteEdgesFrom(fromId, type) {
      const deleted = await db
        .delete(taskRelationshipsTable)
        .where(
          and(eq(taskRelationshipsTable.fromTaskId, fromId), eq(taskRelationshipsTable.type, type))
        )
        .returning({ id: taskRelationshipsTable.id });
      return deleted.length;
    },
    async listFrom(taskId, type) {
      const rows = await db
        .select({ to: taskRelationshipsTable.toTaskId })
        .from(taskRelationshipsTable)
        .where(
          and(eq(taskRelationshipsTable.fromTaskId, taskId), eq(taskRelationshipsTable.type, type))
        );
      return rows.map((r) => r.to);
    },
    async listTo(taskId, type) {
      const rows = await db
        .select({ from: taskRelationshipsTable.fromTaskId })
        .from(taskRelationshipsTable)
        .where(
          and(eq(taskRelationshipsTable.toTaskId, taskId), eq(taskRelationshipsTable.type, type))
        );
      return rows.map((r) => r.from);
    },
    async getAllRelationships(type?) {
      const conditions = type ? [eq(taskRelationshipsTable.type, type)] : [];
      const rows = await db
        .select({
          fromTaskId: taskRelationshipsTable.fromTaskId,
          toTaskId: taskRelationshipsTable.toTaskId,
          type: taskRelationshipsTable.type,
        })
        .from(taskRelationshipsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined);
      return rows as TaskRelationship[];
    },
    async getRelationshipsForTasks(taskIds, type?) {
      if (taskIds.length === 0) return [];
      const taskFilter = or(
        inArray(taskRelationshipsTable.fromTaskId, taskIds),
        inArray(taskRelationshipsTable.toTaskId, taskIds)
      );
      const conditions = type ? and(taskFilter, eq(taskRelationshipsTable.type, type)) : taskFilter;
      const rows = await db
        .select({
          fromTaskId: taskRelationshipsTable.fromTaskId,
          toTaskId: taskRelationshipsTable.toTaskId,
          type: taskRelationshipsTable.type,
        })
        .from(taskRelationshipsTable)
        .where(conditions);
      return rows as TaskRelationship[];
    },
    async getAncestorChain(taskId: string, maxDepth: number): Promise<string[]> {
      const result = await db.execute(sql`
        WITH RECURSIVE ancestors AS (
          SELECT to_task_id AS ancestor_id, 1 AS depth
          FROM task_relationships
          WHERE from_task_id = ${taskId} AND type = 'parent'
          UNION ALL
          SELECT tr.to_task_id, a.depth + 1
          FROM ancestors a
          JOIN task_relationships tr ON tr.from_task_id = a.ancestor_id AND tr.type = 'parent'
          WHERE a.depth < ${maxDepth}
        )
        SELECT ancestor_id FROM ancestors ORDER BY depth
      `);
      return Array.from(result).map((row) => row["ancestor_id"] as string);
    },
    async upsertParent(
      childId: string,
      newParentId: string
    ): Promise<{ previousParent: string | null }> {
      // Fetch existing parent before the upsert so we can return it
      const existing = await db
        .select({ toTaskId: taskRelationshipsTable.toTaskId })
        .from(taskRelationshipsTable)
        .where(
          and(
            eq(taskRelationshipsTable.fromTaskId, childId),
            eq(taskRelationshipsTable.type, "parent")
          )
        )
        .limit(1);
      const previousParent = existing[0]?.toTaskId ?? null;

      // Atomic UPSERT: exploits the tr_one_parent partial unique index
      // (unique on from_task_id WHERE type = 'parent')
      await db
        .insert(taskRelationshipsTable)
        .values({ fromTaskId: childId, toTaskId: newParentId, type: "parent" })
        .onConflictDoUpdate({
          target: [taskRelationshipsTable.fromTaskId],
          targetWhere: sql`type = 'parent'`,
          set: { toTaskId: newParentId },
        });

      return { previousParent };
    },
  };
}

@injectable()
export class TaskGraphService {
  private readonly repo: TaskRelationshipsRepository;

  // Accept either a Drizzle database or a repository implementation
  constructor(dbOrRepo: PostgresJsDatabase | TaskRelationshipsRepository) {
    this.repo =
      typeof (dbOrRepo as PostgresJsDatabase).select === "function"
        ? createDrizzleRepo(dbOrRepo as PostgresJsDatabase)
        : (dbOrRepo as TaskRelationshipsRepository);
  }

  // ── Dependency operations (type = "depends") ─────────────────────────

  async addDependency(fromId: string, toId: string): Promise<{ created: boolean }> {
    validateQualifiedIds(fromId, toId);
    if (fromId === toId) {
      throw new Error("A task cannot depend on itself");
    }

    // Cycle prevention: if fromId is transitively reachable from toId,
    // adding fromId→toId would create a cycle
    const transitiveDeps = await this.getTransitiveDependencies(toId);
    if (transitiveDeps.has(fromId)) {
      throw new Error(`Cycle detected: ${toId} already transitively depends on ${fromId}`);
    }

    const exists = await this.repo.findEdge(fromId, toId, "depends");
    if (exists) {
      return { created: false };
    }
    await this.repo.createEdge(fromId, toId, "depends");
    return { created: true };
  }

  async removeDependency(fromId: string, toId: string): Promise<{ removed: boolean }> {
    const count = await this.repo.deleteEdge(fromId, toId, "depends");
    return { removed: count > 0 };
  }

  async listDependencies(taskId: string): Promise<string[]> {
    return this.repo.listFrom(taskId, "depends");
  }

  async listDependents(taskId: string): Promise<string[]> {
    return this.repo.listTo(taskId, "depends");
  }

  // ── Parent-child operations (type = "parent") ────────────────────────

  /**
   * Set the parent of a child task. A task can have at most one parent.
   * The edge direction is child→parent (from=child, to=parent).
   */
  async addParent(childId: string, parentId: string): Promise<{ created: boolean }> {
    validateQualifiedIds(childId, parentId);
    if (childId === parentId) {
      throw new Error("A task cannot be its own parent");
    }

    // Cycle prevention: ensure parentId is not a descendant of childId
    const ancestors = await this.getAncestors(parentId);
    if (ancestors.includes(childId)) {
      throw new Error(`Cycle detected: ${parentId} is already a descendant of ${childId}`);
    }

    // Check if child already has a parent
    const existingParent = await this.getParent(childId);
    if (existingParent === parentId) {
      return { created: false };
    }
    if (existingParent !== null) {
      throw new Error(`Task ${childId} already has parent ${existingParent}; remove it first`);
    }

    await this.repo.createEdge(childId, parentId, "parent");
    return { created: true };
  }

  /**
   * Remove the parent relationship for a child task.
   * Returns whether a parent edge was actually removed.
   */
  async removeParent(childId: string): Promise<{ removed: boolean }> {
    const count = await this.repo.deleteEdgesFrom(childId, "parent");
    return { removed: count > 0 };
  }

  /**
   * Atomically reparent a task.
   *
   * - `newParentId === null` → orphan the task (remove parent edge).
   * - `newParentId` → UPSERT to the new parent in a single DB operation.
   *
   * Semantics:
   *   - Self-parenting is rejected.
   *   - Cycles are rejected (reuses ancestor-check from addParent).
   *   - No-op: if current parent already equals requested parent, returns
   *     `{ previousParent, newParent }` without any DB writes.
   *
   * Returns `{ taskId, previousParent, newParent }`.
   */
  async reparent(
    childId: string,
    newParentId: string | null
  ): Promise<{ taskId: string; previousParent: string | null; newParent: string | null }> {
    validateQualifiedIds(childId);
    if (newParentId !== null) {
      validateQualifiedIds(newParentId);
    }

    if (newParentId !== null && childId === newParentId) {
      throw new Error("A task cannot be its own parent");
    }

    // Fetch current parent
    const previousParent = await this.getParent(childId);

    // No-op check
    if (previousParent === newParentId) {
      return { taskId: childId, previousParent, newParent: newParentId };
    }

    if (newParentId === null) {
      // Orphan the task — remove parent edge if present
      await this.repo.deleteEdgesFrom(childId, "parent");
      return { taskId: childId, previousParent, newParent: null };
    }

    // Cycle prevention: ensure newParentId is not a descendant of childId
    const ancestors = await this.getAncestors(newParentId);
    if (ancestors.includes(childId)) {
      throw new Error(`Cycle detected: ${newParentId} is already a descendant of ${childId}`);
    }

    // Atomic UPSERT (handles both "no parent yet" and "replace parent" cases)
    await this.repo.upsertParent(childId, newParentId);

    return { taskId: childId, previousParent, newParent: newParentId };
  }

  /**
   * Get the parent of a task, or null if it has no parent.
   */
  async getParent(taskId: string): Promise<string | null> {
    const parents = await this.repo.listFrom(taskId, "parent");
    return parents[0] ?? null;
  }

  /**
   * List the direct children (subtasks) of a task.
   */
  async listChildren(taskId: string): Promise<string[]> {
    return this.repo.listTo(taskId, "parent");
  }

  /**
   * Walk up the parent chain from a task, returning all ancestors.
   * Uses a single recursive CTE query to fetch the entire ancestor chain.
   * Stops at root (no parent) or max depth.
   */
  async getAncestors(taskId: string, maxDepth = 10): Promise<string[]> {
    return this.repo.getAncestorChain(taskId, maxDepth);
  }

  /**
   * BFS over "depends" edges from a task, returning all transitive dependencies.
   * Uses batched edge lookups per BFS frontier to minimize DB round-trips.
   * Used for cycle detection before adding a new dependency edge.
   */
  async getTransitiveDependencies(taskId: string, maxNodes = 100): Promise<Set<string>> {
    const visited = new Set<string>();
    let frontier = [taskId];

    while (frontier.length > 0 && visited.size < maxNodes) {
      // Batch-fetch all "depends" edges for the entire frontier
      const edges = await this.repo.getRelationshipsForTasks(frontier, "depends");

      // Mark frontier as visited
      for (const node of frontier) {
        visited.add(node);
      }

      // Collect next frontier from discovered edges
      const nextFrontier: string[] = [];
      for (const edge of edges) {
        // "depends" edges: fromTaskId depends on toTaskId
        if (visited.has(edge.fromTaskId) && !visited.has(edge.toTaskId)) {
          nextFrontier.push(edge.toTaskId);
        }
      }
      frontier = nextFrontier;
    }

    visited.delete(taskId); // don't include the starting node itself
    return visited;
  }

  // ── Bulk operations (all types by default) ────────────────────────────

  /**
   * Get all relationships at once — efficient for graph visualization.
   * Pass a type to filter; omit to get all edge types.
   */
  async getAllRelationships(type?: RelationshipType): Promise<TaskRelationship[]> {
    return this.repo.getAllRelationships(type);
  }

  /**
   * Get relationships for a specific set of tasks — efficient for filtered graphs.
   * Pass a type to filter; omit to get all edge types.
   */
  async getRelationshipsForTasks(
    taskIds: string[],
    type?: RelationshipType
  ): Promise<TaskRelationship[]> {
    return this.repo.getRelationshipsForTasks(taskIds, type);
  }
}
