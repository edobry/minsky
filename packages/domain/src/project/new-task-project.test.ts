/**
 * Tests for the new-task project resolution introduced by mt#4808.
 *
 * The precedence is pure, so it is asserted directly — no db, no spies, no
 * patched collaborators (the mt#3628 pattern its siblings `scope-resolver.ts`
 * and `task-project-repo.ts` use).
 */

import { describe, expect, it } from "bun:test";
import { tasksTable } from "../storage/schemas/task-embeddings";
import {
  decideNewTaskProject,
  resolveNewTaskProjectId,
  resolveTaskProjectId,
} from "./new-task-project";
import type { TaskProjectDb } from "./task-project-repo";

const MINSKY_ID = "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe";
const PEEZOMBIE_ID = "2ef29b41-413e-4ecf-a61b-e695697e7d82";

function dbWithTasks(rows: unknown[]): TaskProjectDb {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(table === tasksTable ? rows : []) }),
      }),
    }),
  };
}

describe("decideNewTaskProject — the precedence, pure (mt#4808)", () => {
  it("prefers an explicit location over the parent's project", () => {
    const d = decideNewTaskProject({
      explicitLocationProjectId: PEEZOMBIE_ID,
      parentProjectId: MINSKY_ID,
      filingContextProjectId: MINSKY_ID,
    });

    expect(d.projectId).toBe(PEEZOMBIE_ID);
    expect(d.source).toBe("explicit-location");
  });

  it("falls to the parent's project when no location was given", () => {
    const d = decideNewTaskProject({
      parentProjectId: PEEZOMBIE_ID,
      filingContextProjectId: MINSKY_ID,
    });

    expect(d.projectId).toBe(PEEZOMBIE_ID);
    expect(d.source).toBe("parent-task");
  });

  it("falls to the filing context when neither resolved — today's behavior", () => {
    const d = decideNewTaskProject({ filingContextProjectId: MINSKY_ID });

    expect(d.projectId).toBe(MINSKY_ID);
    expect(d.source).toBe("filing-context");
  });

  it("yields undefined when nothing resolves, rather than inventing a project", () => {
    const d = decideNewTaskProject({});

    expect(d.projectId).toBeUndefined();
    expect(d.source).toBe("filing-context");
  });
});

describe("resolveTaskProjectId — the parent lookup (mt#4808)", () => {
  it("returns the parent task's project", async () => {
    const id = await resolveTaskProjectId(
      "mt#4678",
      dbWithTasks([{ id: "mt#4678", projectId: PEEZOMBIE_ID }])
    );
    expect(id).toBe(PEEZOMBIE_ID);
  });

  it("returns undefined for a task with a null project_id", async () => {
    const id = await resolveTaskProjectId("mt#1", dbWithTasks([{ id: "mt#1", projectId: null }]));
    expect(id).toBeUndefined();
  });

  it("returns undefined when no task id is supplied", async () => {
    expect(await resolveTaskProjectId(undefined, dbWithTasks([]))).toBeUndefined();
  });

  it("returns undefined rather than throwing on a broken db handle", async () => {
    expect(await resolveTaskProjectId("mt#1", { notADb: true })).toBeUndefined();
  });

  it("returns undefined rather than throwing when the query rejects", async () => {
    const exploding: TaskProjectDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error("connection lost")) }),
        }),
      }),
    };
    expect(await resolveTaskProjectId("mt#1", exploding)).toBeUndefined();
  });
});

describe("resolveNewTaskProjectId — the wired resolver (mt#4808)", () => {
  it("takes the parent's project when no explicit location is given", async () => {
    const decision = await resolveNewTaskProjectId(
      { parentTaskId: "mt#4678" },
      dbWithTasks([{ id: "mt#4678", projectId: PEEZOMBIE_ID }])
    );

    expect(decision.projectId).toBe(PEEZOMBIE_ID);
    expect(decision.source).toBe("parent-task");
  });

  it("fails open to the filing context when nothing resolves", async () => {
    // No parent, and a location that no project row matches.
    const decision = await resolveNewTaskProjectId({ parentTaskId: "mt#404" }, dbWithTasks([]));

    expect(decision.projectId).toBeUndefined();
    expect(decision.source).toBe("filing-context");
  });

  it("fails open on a broken db handle rather than throwing", async () => {
    const decision = await resolveNewTaskProjectId({ parentTaskId: "mt#4678" }, { notADb: true });

    expect(decision.projectId).toBeUndefined();
    expect(decision.source).toBe("filing-context");
  });
});
