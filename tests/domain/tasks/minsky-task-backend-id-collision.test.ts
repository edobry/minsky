/**
 * Regression tests for the tasks_create id-collision bug (mt#1011).
 *
 * Root cause: generateTaskId reads MAX(id) then proposes maxId+1, but another
 * concurrent writer may claim that id between the SELECT and the INSERT.
 * The fix uses onConflictDoNothing + a retry loop so collisions are detected
 * rather than masking them with a silent onConflictDoUpdate clobber.
 *
 * These tests exercise the collision-detection path using a fake DB that
 * simulates a concurrent writer having already claimed the "next" id.
 */

import { describe, it, expect } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { MinskyTaskBackend } from "../../../src/domain/tasks/minskyTaskBackend";

// ── Minimal in-memory fake DB ─────────────────────────────────────────────────
//
// We only need to stub the Drizzle query-builder methods used by
// MinskyTaskBackend:  .select().from().where()  and  .insert().values()...
// The fake uses a Map<id, row> as its task store.

type TaskRow = {
  id: string;
  title: string | null;
  status: string | null;
  backend: string | null;
  tags: string | null;
  sourceTaskId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type SpecRow = {
  taskId: string;
  content: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeDb(initialTasks: TaskRow[] = []) {
  const tasks = new Map<string, TaskRow>(initialTasks.map((r) => [r.id, r]));
  const specs = new Map<string, SpecRow>();

  // Helper that builds a chainable query object.
  // Each method returns `this` so callers can chain fluently.

  function makeTaskInsertChain(row: TaskRow) {
    let conflictMode: "doNothing" | "doUpdate" | null = null;

    const chain = {
      onConflictDoNothing() {
        conflictMode = "doNothing";
        return chain;
      },
      onConflictDoUpdate(_opts: unknown) {
        conflictMode = "doUpdate";
        return chain;
      },
      returning(_fields: unknown) {
        // Simulate the insert
        if (tasks.has(row.id)) {
          if (conflictMode === "doNothing") return Promise.resolve([]);
          if (conflictMode === "doUpdate") {
            tasks.set(row.id, row);
            return Promise.resolve([{ id: row.id }]);
          }
        }
        tasks.set(row.id, row);
        return Promise.resolve([{ id: row.id }]);
      },
    };
    return chain;
  }

  function makeSpecInsertChain(row: SpecRow) {
    let conflictMode: "doNothing" | "doUpdate" | null = null;

    const chain = {
      onConflictDoNothing() {
        conflictMode = "doNothing";
        return chain;
      },
      onConflictDoUpdate(_opts: unknown) {
        conflictMode = "doUpdate";
        return chain;
      },
      // specs insert sometimes doesn't chain .returning()
      then(resolve: (v: unknown) => void) {
        // If the spec already exists in doNothing mode, skip
        if (!specs.has(row.taskId) || conflictMode === "doUpdate") {
          specs.set(row.taskId, row);
        }
        resolve(undefined);
      },
    };
    return chain;
  }

  function makeSelectChain(rows: Array<{ id: string }>) {
    return {
      from(_table: unknown) {
        return {
          where(_cond: unknown) {
            return Promise.resolve(rows);
          },
          limit(_n: number) {
            return Promise.resolve(rows.slice(0, 1));
          },
        };
      },
    };
  }

  const fakeDb = {
    _tasks: tasks,
    _specs: specs,

    select(fields?: unknown) {
      // Return id rows for all tasks matching mt# prefix
      const idRows = Array.from(tasks.values()).map((r) => ({ id: r.id }));
      return makeSelectChain(idRows);
    },

    insert(table: unknown) {
      return {
        values(row: TaskRow | SpecRow) {
          // Distinguish task vs spec by key presence
          if ("taskId" in row) {
            return makeSpecInsertChain(row as SpecRow);
          }
          return makeTaskInsertChain(row as TaskRow);
        },
      };
    },

    // update / delete stubs (not used by createTaskFromTitleAndSpec)
    update(_table: unknown) {
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
    delete(_table: unknown) {
      return { where: () => ({ returning: () => Promise.resolve([]) }) };
    },
  };

  return fakeDb as unknown as PostgresJsDatabase & {
    _tasks: Map<string, TaskRow>;
    _specs: Map<string, SpecRow>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBackend(db: PostgresJsDatabase) {
  return new MinskyTaskBackend({ name: "minsky", db, workspacePath: "/fake" });
}

function makeTask(id: string, title = "Existing task"): TaskRow {
  return {
    id,
    title,
    status: "TODO",
    backend: "minsky",
    tags: "[]",
    sourceTaskId: id.split("#")[1] ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MinskyTaskBackend — id collision regression (mt#1011)", () => {
  it("creates a task and returns the new id", async () => {
    const db = createFakeDb([makeTask("mt#1")]);
    const backend = makeBackend(db);

    const task = await backend.createTaskFromTitleAndSpec("My new task", "spec content");

    expect(task.id).toBe("mt#2");
    expect(task.title).toBe("My new task");
    expect(task.backend).toBe("minsky");
    expect(db._tasks.has("mt#2")).toBe(true);
    expect(db._specs.has("mt#2")).toBe(true);
  });

  it("detects a collision and retries to produce a distinct id", async () => {
    // Pre-populate mt#1 and mt#2 so that the first generateTaskId call returns
    // mt#2 (maxId=1+1) — but mt#2 is already taken.  The retry loop must then
    // re-read and propose mt#3.
    //
    // We simulate the race by pre-inserting mt#2 *before* the backend runs,
    // which means its first insert attempt will hit onConflictDoNothing and
    // loop around to generate mt#3.
    const db = createFakeDb([makeTask("mt#1"), makeTask("mt#2", "Already exists")]);
    const backend = makeBackend(db);

    const task = await backend.createTaskFromTitleAndSpec("Race winner", "spec");

    // The new task must not clobber mt#2 and must get a fresh id
    expect(task.id).not.toBe("mt#2");
    expect(task.id).toBe("mt#3");

    // The original mt#2 must be unchanged
    const original = db._tasks.get("mt#2");
    expect(original?.title).toBe("Already exists");

    // The new task is present
    expect(db._tasks.get("mt#3")?.title).toBe("Race winner");
  });

  it("does NOT clobber an existing task when id collides (was the original bug)", async () => {
    const db = createFakeDb([makeTask("mt#5", "Persist subagent execution history records")]);
    const backend = makeBackend(db);

    // Create a new task — generateTaskId returns mt#6 (max is 5, next is 6)
    const task = await backend.createTaskFromTitleAndSpec("Memory system parent", "new spec");

    // Must get a fresh id, not mt#5
    expect(task.id).not.toBe("mt#5");

    // The existing mt#5 title must be untouched
    expect(db._tasks.get("mt#5")?.title).toBe("Persist subagent execution history records");
  });

  it("two sequential creates get distinct ids", async () => {
    const db = createFakeDb();
    const backend = makeBackend(db);

    const t1 = await backend.createTaskFromTitleAndSpec("First task", "spec1");
    const t2 = await backend.createTaskFromTitleAndSpec("Second task", "spec2");

    expect(t1.id).not.toBe(t2.id);
    expect(db._tasks.size).toBe(2);
    expect(db._specs.size).toBe(2);
  });

  it("throws when a caller-supplied id is already taken", async () => {
    const db = createFakeDb([makeTask("mt#42", "Original")]);
    const backend = makeBackend(db);

    await expect(
      backend.createTaskFromTitleAndSpec("Duplicate", "spec", { id: "mt#42" })
    ).rejects.toThrow(/already exists/);

    // Original must still be intact
    expect(db._tasks.get("mt#42")?.title).toBe("Original");
  });
});
