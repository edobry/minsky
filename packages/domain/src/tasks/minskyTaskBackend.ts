import { eq, not, and, like, inArray, type SQL } from "drizzle-orm";
import { TaskStatus } from "./taskConstants";
// Remove configuration import - dependencies should be injected
import {
  tasksTable,
  taskSpecsTable,
  tasksEmbeddingsTable,
  deletedTaskIdsTable,
} from "../storage/schemas/task-embeddings";
import { first } from "@minsky/shared/array-safety";
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
import { isAllProjects } from "../project/scope";

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
  // Atomic multi-statement work. The callback receives a transaction-scoped
  // handle that structurally satisfies this same interface. Drizzle's
  // PostgresJsDatabase.transaction matches; test fakes implement it by
  // invoking the callback with themselves.
  transaction<T>(fn: (tx: MinskyBackendDb) => Promise<T>): Promise<T>;
}

export interface MinskyTaskBackendConfig extends TaskBackendConfig {
  db: MinskyBackendDb;
  /**
   * Project uuid for new task rows (ADR-021, mt#2416).
   * Set to the resolved project id when the backend is created in a
   * CLI/stdio context; undefined when project identity is unavailable
   * (hosted server, unidentified → rows are inserted without a project_id).
   */
  currentProjectId?: string;
}

/**
 * Compute the next monotonic "mt#" task id (mt#2205).
 *
 * The next id is `mt#<max + 1>` where the max is taken over BOTH the live
 * task ids AND the deleted-task-id tombstones. Including tombstones is what
 * makes allocation monotonic: deleting the highest-numbered task no longer
 * lowers the max, so a freed id is never re-handed-out to a new task. This
 * preserves the invariant that a task id is a stable permanent reference.
 *
 * Non-"mt#" ids and unparseable ids are ignored (only the numeric suffix of
 * `mt#<n>` participates in the max). With no parseable ids on either side the
 * result is `mt#1`.
 *
 * Pure function — the IO (two SELECTs) lives in the caller so this logic is
 * directly unit-testable without a database.
 */
export function computeNextTaskId(liveIds: string[], tombstoneIds: string[]): string {
  const maxId = [...liveIds, ...tombstoneIds].reduce((acc: number, id: string) => {
    if (typeof id !== "string" || !id.startsWith("mt#")) {
      return acc;
    }
    const num = parseInt(id.slice("mt#".length), 10);
    return !isNaN(num) && num > acc ? num : acc;
  }, 0);

  return `mt#${maxId + 1}`;
}

export class MinskyTaskBackend implements TaskBackend {
  name = "minsky";
  prefix?: string;
  private readonly db: MinskyBackendDb;
  private readonly workspacePath: string;
  /** Project uuid stamped onto new task rows (undefined = no project scoping). */
  private readonly currentProjectId: string | undefined;

  constructor(config: MinskyTaskBackendConfig) {
    this.workspacePath = config.workspacePath;
    this.db = config.db; // Database connection injected as dependency
    this.currentProjectId = config.currentProjectId;
  }

  // Database connection is now injected - no need for createDbConnection method

  // ---- User-Facing Operations ----

  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    const conditions: SQL[] = [];

    if (options?.status && options.status !== "all") {
      conditions.push(eq(tasksTable.status, options.status));
    } else if (!options?.all) {
      // Default: exclude terminal statuses unless --all is specified.
      // Terminal set = DONE + CLOSED (single success terminal since mt#2311;
      // rows at the retired COMPLETED value were migrated to DONE). Kept in
      // sync with TASK_STATUSES_HIDDEN_BY_DEFAULT in task-filters.ts.
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

    // Filter by workflow kind if specified (mt#2762). Validated against the
    // workflow registry by the caller (assertKnownKind) before it reaches here.
    if (options?.kind) {
      conditions.push(eq(tasksTable.kind, options.kind));
    }

    // Project scope filter (ADR-021, mt#2416)
    if (options?.projectScope && !isAllProjects(options.projectScope)) {
      conditions.push(eq(tasksTable.projectId, options.projectScope));
    }

    const query = this.db.select().from(tasksTable);
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
    return rows.map((row: (typeof rows)[number]) => this.mapDbRowToTask(row));
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
    return rows.map((row: (typeof rows)[number]) => this.mapDbRowToTask(row));
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
      const insertedAt = await this.tryInsertTask(id, title, spec, options);
      if (insertedAt) {
        const tags = options?.tags || [];
        const kind = options?.kind || "implementation";
        return {
          id,
          title,
          status: "TODO",
          kind,
          backend: this.name,
          tags,
          createdAt: insertedAt,
          updatedAt: insertedAt,
        };
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
   *
   * The task-row + spec-row writes run in a single transaction so a task can
   * never be left without its spec on a partial failure (mt#2205). The spec
   * write upserts (onConflictDoUpdate) rather than no-ops: if a stale orphaned
   * spec row pre-dates migration 0043 (a delete before tombstones existed) and
   * its freed id is re-proposed, the new task's spec MUST win — a no-op here is
   * exactly the title/spec desync mt#2205 fixes.
   */
  private async tryInsertTask(
    id: string,
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Date | null> {
    const tags = options?.tags || [];
    // Single timestamp shared by the written row and the returned Task so the
    // freshly-created object's createdAt/updatedAt exactly match what a later
    // read surfaces (mt#2259 — avoid post-create vs read shape drift).
    const now = new Date();

    return this.db.transaction(async (tx) => {
      // Insert task metadata row; do nothing on id conflict
      const inserted = await tx
        .insert(tasksTable)
        .values({
          id,
          sourceTaskId: id.split("#")[1], // Extract the numeric part
          backend: "minsky" as const,
          status: (options?.status || "TODO") as (typeof TaskStatus)[keyof typeof TaskStatus],
          title,
          tags: JSON.stringify(tags),
          kind: options?.kind || "implementation",
          createdAt: now,
          updatedAt: now,
          // Project scoping (ADR-021, mt#2416): stamp project uuid when available
          projectId: this.currentProjectId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: tasksTable.id });

      if (inserted.length === 0) {
        // Conflict — the id was already taken
        return null;
      }

      // Upsert spec content so the new task's spec always wins over any stale
      // orphaned row for this id (defends against pre-0043 historical orphans).
      await tx
        .insert(taskSpecsTable)
        .values({
          taskId: id,
          content: spec,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: taskSpecsTable.taskId,
          set: { content: spec, updatedAt: now },
        });

      return now;
    });
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
    // Single timestamp shared by the written row and the returned Task (mt#2259).
    const now = new Date();

    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(tasksTable)
        .values({
          id,
          sourceTaskId: id.split("#")[1],
          backend: "minsky" as const,
          status: (options?.status || "TODO") as (typeof TaskStatus)[keyof typeof TaskStatus],
          title,
          tags: JSON.stringify(tags),
          kind: options?.kind || "implementation",
          createdAt: now,
          updatedAt: now,
          // Project scoping (ADR-021, mt#2416): stamp project uuid when available
          projectId: this.currentProjectId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: tasksTable.id });

      if (inserted.length === 0) {
        // Throwing rolls the transaction back.
        throw new Error(
          `Task id "${id}" already exists. Use a different id or omit it to auto-generate.`
        );
      }

      // Upsert spec content so it always wins over any stale orphaned row
      // for this id (see tryInsertTask for the mt#2205 rationale).
      await tx
        .insert(taskSpecsTable)
        .values({
          taskId: id,
          content: spec,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: taskSpecsTable.taskId,
          set: { content: spec, updatedAt: now },
        });
    });

    const kind = options?.kind || "implementation";
    return {
      id,
      title,
      status: "TODO",
      kind,
      backend: this.name,
      tags,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteTask(id: string, options?: DeleteTaskOptions): Promise<boolean> {
    // The purge + tombstone runs atomically: either the task row, its
    // dependent rows, and the tombstone all commit, or none do. A partial
    // failure here would leave the data-integrity-inconsistent states this
    // fix exists to prevent — task gone but spec/embedding orphaned, or
    // dependents deleted but no tombstone recorded (mt#2205).
    return this.db.transaction(async (tx) => {
      // Hard-delete the task metadata row.
      const deleted = await tx
        .delete(tasksTable)
        .where(eq(tasksTable.id, id))
        .returning({ id: tasksTable.id });

      // Purge dependent rows. Migration 0011 dropped the ON DELETE CASCADE FKs
      // that previously cleaned these automatically (mt#2205); without this,
      // the spec and embedding rows are orphaned. Always run these even when
      // the task row was already absent, so a partially-orphaned state
      // self-heals on re-delete.
      await tx.delete(taskSpecsTable).where(eq(taskSpecsTable.taskId, id));
      await tx.delete(tasksEmbeddingsTable).where(eq(tasksEmbeddingsTable.id, id));

      // Record a tombstone so generateTaskId's high-water mark never recedes:
      // a deleted ID is retired forever and never re-handed-out to a new task.
      await tx
        .insert(deletedTaskIdsTable)
        .values({ id, deletedAt: new Date() })
        .onConflictDoNothing();

      return deleted.length > 0;
    });
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
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
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

  async setTaskKind(id: string, kind: string): Promise<void> {
    await this.db
      .update(tasksTable)
      .set({
        kind,
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
    kind?: string | null;
    createdAt?: Date | null;
    updatedAt?: Date | null;
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
      kind: row.kind ?? "implementation",
      backend: this.name,
      tags,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    };
  }

  private async generateTaskId(_title: string): Promise<string> {
    // Fetch all mt# task ids and compute max numerically.
    // We cannot use a DB-level SERIAL here because ids are stored as strings
    // (e.g. "mt#123"), so we perform a lightweight SELECT of ids only and
    // derive the next number in application code.
    //
    // Monotonic allocation (mt#2205): the max is computed over LIVE task rows
    // UNION the deleted-task-id tombstones. Without the tombstones, deleting
    // the highest-numbered task would lower the max and the next create would
    // re-hand-out the freed id (the observed mt#2195 reuse). Including
    // tombstones means a deleted id is retired forever — preserving the
    // invariant that a task id is a stable permanent reference.
    //
    // Race safety: the caller (createTaskFromTitleAndSpec) uses onConflictDoNothing
    // + a retry loop so a concurrent writer claiming this id is detected and
    // handled without silently clobbering existing data.
    const liveRows = await this.db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(like(tasksTable.id, "mt#%"));

    const tombstoneRows = await this.db
      .select({ id: deletedTaskIdsTable.id })
      .from(deletedTaskIdsTable)
      .where(like(deletedTaskIdsTable.id, "mt#%"));

    return computeNextTaskId(
      liveRows.map((r: { id: string }) => r.id),
      tombstoneRows.map((r: { id: string }) => r.id)
    );
  }
}

// Factory function - now requires database connection
export function createMinskyTaskBackend(config: MinskyTaskBackendConfig): MinskyTaskBackend {
  return new MinskyTaskBackend(config);
}
