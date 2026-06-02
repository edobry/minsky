/**
 * Regression tests for mt#2205 — deleted task IDs must not be reused, and
 * deleteTask must purge all dependent rows (spec + embedding) so a reused ID
 * (in the OR-branch) or a stale orphan can never desync a task's title from
 * its spec body.
 *
 * Two layers:
 *  - computeNextTaskId: pure allocation logic (monotonic over live ∪ tombstones).
 *  - deleteTask: orchestration — purges tasks/task_specs/tasks_embeddings and
 *    records a tombstone. Exercised with a recording fake DB.
 */
import { describe, test, expect } from "bun:test";
import { MinskyTaskBackend, computeNextTaskId } from "./minskyTaskBackend";
import {
  tasksTable,
  taskSpecsTable,
  tasksEmbeddingsTable,
  deletedTaskIdsTable,
} from "../storage/schemas/task-embeddings";

describe("computeNextTaskId (mt#2205 monotonic allocation)", () => {
  test("empty state allocates mt#1", () => {
    expect(computeNextTaskId([], [])).toBe("mt#1");
  });

  test("max over live ids + 1", () => {
    expect(computeNextTaskId(["mt#1", "mt#2", "mt#3"], [])).toBe("mt#4");
  });

  test("tombstones raise the high-water mark above live ids", () => {
    // Live max is 5, but a higher id (7) was deleted — next must clear 7.
    expect(computeNextTaskId(["mt#5"], ["mt#7"])).toBe("mt#8");
  });

  test("REGRESSION: create→delete→create does not reuse the freed id", () => {
    // mt#3 was the highest task, then deleted (now a tombstone, no live rows).
    // The pre-fix MAX(live)+1 would return mt#3 again (reuse). With the
    // tombstone included, the next id is mt#4 — the freed id is retired.
    expect(computeNextTaskId([], ["mt#3"])).toBe("mt#4");
  });

  test("non-mt# ids and unparseable ids are ignored", () => {
    expect(computeNextTaskId(["md#999", "gh#888", "mt#2", "mt#notanumber"], [])).toBe("mt#3");
  });

  test("only tombstones, no live tasks", () => {
    expect(computeNextTaskId([], ["mt#1", "mt#10", "mt#4"])).toBe("mt#11");
  });
});

/**
 * Recording fake of the narrow MinskyBackendDb surface. It records which
 * tables receive delete / insert calls (by table-object identity) without
 * interpreting drizzle SQL conditions — sufficient to assert deleteTask's
 * purge-and-tombstone orchestration. `taskRowExists` controls whether the
 * tasks-row delete reports a row was removed (drives deleteTask's return).
 */
function makeRecordingDb(taskRowExists: boolean) {
  const deletedTables: unknown[] = [];
  const insertedTables: unknown[] = [];
  const insertedValues: unknown[] = [];

  // A thenable that also carries optional chain methods.
  const awaitable = <T>(value: T, extra: Record<string, unknown> = {}) => ({
    then: (onF: (v: T) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(onF, onR),
    ...extra,
  });

  const db = {
    delete(table: unknown) {
      deletedTables.push(table);
      return {
        where(_cond: unknown) {
          // tasks-row delete uses .returning(); dependent deletes are awaited directly.
          return awaitable(undefined, {
            returning: (_fields: unknown) =>
              awaitable(table === tasksTable && taskRowExists ? [{ id: "mt#5" }] : []),
          });
        },
      };
    },
    insert(table: unknown) {
      insertedTables.push(table);
      return {
        values(v: unknown) {
          insertedValues.push(v);
          return {
            onConflictDoNothing: () => awaitable(undefined),
            onConflictDoUpdate: (_args: unknown) => awaitable(undefined),
          };
        },
      };
    },
    // Run the callback against this same recording fake so the operations
    // inside deleteTask's transaction are still recorded.
    transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(this);
    },
    // Unused by deleteTask but required by the interface.
    select() {
      return { from: () => ({ where: () => awaitable([]) }) };
    },
    update() {
      return { set: () => ({ where: () => awaitable(undefined) }) };
    },
  };

  return { db, deletedTables, insertedTables, insertedValues };
}

describe("MinskyTaskBackend.deleteTask (mt#2205 purge + tombstone)", () => {
  test("purges tasks, task_specs, and tasks_embeddings and records a tombstone", async () => {
    const { db, deletedTables, insertedTables, insertedValues } = makeRecordingDb(true);
    const backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    const result = await backend.deleteTask("mt#5");

    expect(result).toBe(true);
    // All three data tables are purged (orphan fix).
    expect(deletedTables).toContain(tasksTable);
    expect(deletedTables).toContain(taskSpecsTable);
    expect(deletedTables).toContain(tasksEmbeddingsTable);
    // A tombstone is written so the id is retired forever.
    expect(insertedTables).toContain(deletedTaskIdsTable);
    expect(insertedValues).toEqual([{ id: "mt#5", deletedAt: expect.any(Date) }]);
  });

  test("still purges dependents and tombstones when the task row was already absent", async () => {
    const { db, deletedTables, insertedTables } = makeRecordingDb(false);
    const backend = new MinskyTaskBackend({ db, workspacePath: "/tmp/ws" } as never);

    const result = await backend.deleteTask("mt#5");

    // No task row removed → false, but the self-healing purge + tombstone still run.
    expect(result).toBe(false);
    expect(deletedTables).toContain(taskSpecsTable);
    expect(deletedTables).toContain(tasksEmbeddingsTable);
    expect(insertedTables).toContain(deletedTaskIdsTable);
  });
});

/**
 * Read-only fake of the MinskyBackendDb select surface. `getTask` issues
 * `select().from(tasksTable).where().limit(1)`; `getTaskMetadata` additionally
 * issues a `select().from(taskSpecsTable).where().limit(1)` for the spec body.
 * The chain branches on the table captured in `from()` so a single fake serves
 * both reads.
 */
function makeSelectDb(taskRow: Record<string, unknown>, specContent = "spec body") {
  const db = {
    select() {
      let selectedTable: unknown;
      const chain: Record<string, unknown> = {
        from(table: unknown) {
          selectedTable = table;
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          if (selectedTable === taskSpecsTable) {
            return Promise.resolve([{ content: specContent }]);
          }
          return Promise.resolve([taskRow]);
        },
      };
      return chain;
    },
  };
  return db;
}

describe("MinskyTaskBackend timestamp surfacing (mt#2259)", () => {
  const createdAt = new Date("2026-06-01T12:00:00.000Z");
  const updatedAt = new Date("2026-06-02T08:30:00.000Z");
  const baseRow = {
    id: "mt#42",
    title: "A task",
    status: "TODO",
    tags: null,
    kind: "implementation",
    createdAt,
    updatedAt,
  };

  test("getTask surfaces createdAt/updatedAt from the DB row", async () => {
    const backend = new MinskyTaskBackend({
      db: makeSelectDb(baseRow),
      workspacePath: "/tmp/ws",
    } as never);

    const task = await backend.getTask("mt#42");

    expect(task).not.toBeNull();
    expect(task?.createdAt).toEqual(createdAt);
    expect(task?.updatedAt).toEqual(updatedAt);
  });

  test("getTaskMetadata returns non-undefined createdAt/updatedAt (was hardcoded undefined)", async () => {
    const backend = new MinskyTaskBackend({
      db: makeSelectDb(baseRow),
      workspacePath: "/tmp/ws",
    } as never);

    const meta = await backend.getTaskMetadata("mt#42");

    expect(meta).not.toBeNull();
    expect(meta?.createdAt).toEqual(createdAt);
    expect(meta?.updatedAt).toEqual(updatedAt);
  });

  test("missing timestamps are omitted rather than surfaced as null", async () => {
    const backend = new MinskyTaskBackend({
      db: makeSelectDb({ ...baseRow, createdAt: null, updatedAt: null }),
      workspacePath: "/tmp/ws",
    } as never);

    const task = await backend.getTask("mt#42");

    expect(task?.createdAt).toBeUndefined();
    expect(task?.updatedAt).toBeUndefined();
  });
});
