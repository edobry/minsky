/**
 * Regression tests for the tasks_children / tasks_parent param fix (mt#2737).
 *
 * The bug: these two commands named their param `task` while the rest of the
 * tasks_* family uses `taskId`. A caller following convention passed `taskId`,
 * so `params.task` arrived undefined and the relationship query ran with an
 * undefined bind (UNDEFINED_VALUE). The fix makes `taskId` canonical and keeps
 * `task` as a permanent back-compat alias (Postel's law), enforced by
 * `resolveTaskId`.
 *
 * These tests assert the resolved id reaches the TaskGraphService call for BOTH
 * param names, and that supplying NEITHER raises a clear ValidationError rather
 * than dropping an undefined into the query (the original bug). A throwing-stub
 * service keeps this a pure command-boundary unit test (no DB, no module mocking).
 *
 * Note: `InferParams` maps every declared key to its `z.infer` type (value
 * `string | undefined` for optional params) but keeps the KEY present, so the
 * execute input carries both `taskId` and `task` — the tests pass both keys
 * explicitly (one set, one undefined) to match that shape and exercise each path.
 */

import { describe, test, expect } from "bun:test";
import {
  createTasksChildrenCommand,
  createTasksParentCommand,
  createTasksDepsAddCommand,
  createTasksDepsRmCommand,
  createTasksDepsListCommand,
} from "./deps-commands";
import { ValidationError } from "@minsky/domain/errors/index";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";

const PARENT_ID = "mt#1552";
const CHILD_ID = "mt#2739";
const DEP_ID = "mt#100";

function childrenService(calls: Array<string | undefined>, result: string[]): TaskGraphService {
  return {
    listChildren: async (id: string) => {
      calls.push(id);
      return result;
    },
  } as unknown as TaskGraphService;
}

function parentService(calls: Array<string | undefined>, result: string | null): TaskGraphService {
  return {
    getParent: async (id: string) => {
      calls.push(id);
      return result;
    },
  } as unknown as TaskGraphService;
}

describe("tasks_children / tasks_parent taskId resolution (mt#2737)", () => {
  test("tasks.children threads the canonical taskId into service.listChildren", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksChildrenCommand(() => childrenService(calls, ["mt#100", "mt#101"]));
    const result = await cmd.execute({ taskId: PARENT_ID, task: undefined });

    // The resolved id must reach the service — [undefined] here is the bug.
    expect(calls).toEqual([PARENT_ID]);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${PARENT_ID}: 2 subtask(s)`);
  });

  test("tasks.children accepts the legacy `task` alias", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksChildrenCommand(() => childrenService(calls, ["mt#100"]));
    const result = await cmd.execute({ taskId: undefined, task: PARENT_ID });

    expect(calls).toEqual([PARENT_ID]);
    expect(result.success).toBe(true);
  });

  test("tasks.children reports no subtasks when the service returns none", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksChildrenCommand(() => childrenService(calls, []));
    const result = await cmd.execute({ taskId: PARENT_ID, task: undefined });

    expect(calls).toEqual([PARENT_ID]);
    expect(result.output).toContain(`${PARENT_ID}: no subtasks`);
  });

  test("tasks.children rejects a call with neither taskId nor task", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksChildrenCommand(() => childrenService(calls, []));
    await expect(cmd.execute({ taskId: undefined, task: undefined })).rejects.toBeInstanceOf(
      ValidationError
    );
    // The service is never reached with an undefined id (the original UNDEFINED_VALUE bug).
    expect(calls).toEqual([]);
  });

  test("tasks.parent threads the canonical taskId into service.getParent", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksParentCommand(() => parentService(calls, PARENT_ID));
    const result = await cmd.execute({ taskId: CHILD_ID, task: undefined });

    expect(calls).toEqual([CHILD_ID]);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${CHILD_ID}: parent is ${PARENT_ID}`);
  });

  test("tasks.parent accepts the legacy `task` alias", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksParentCommand(() => parentService(calls, PARENT_ID));
    const result = await cmd.execute({ taskId: undefined, task: CHILD_ID });

    expect(calls).toEqual([CHILD_ID]);
    expect(result.success).toBe(true);
  });

  test("tasks.parent reports a root task when the service returns null", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksParentCommand(() => parentService(calls, null));
    const result = await cmd.execute({ taskId: CHILD_ID, task: undefined });

    expect(calls).toEqual([CHILD_ID]);
    expect(result.output).toContain(`${CHILD_ID}: no parent (root task)`);
  });

  test("tasks.parent rejects a call with neither taskId nor task", async () => {
    const calls: Array<string | undefined> = [];
    const cmd = createTasksParentCommand(() => parentService(calls, null));
    await expect(cmd.execute({ taskId: undefined, task: undefined })).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(calls).toEqual([]);
  });
});

/**
 * mt#2741: the same drift affected the deps subfamily — deps.add/rm/list declared
 * `task` (not the tasks_* `taskId` convention). Same fix (canonical `taskId` +
 * `task` alias via the shared resolveTaskId). These assert the resolved id reaches
 * the service from BOTH names, `dependsOn` is unaffected, and neither → ValidationError.
 */
describe("tasks_deps_* taskId resolution (mt#2741)", () => {
  test("tasks.deps.add resolves taskId (and the task alias) into addDependency", async () => {
    const addCalls: Array<[string | undefined, string | undefined]> = [];
    const service = {
      addDependency: async (a: string, b: string) => {
        addCalls.push([a, b]);
        return { created: true };
      },
    } as unknown as TaskGraphService;
    const cmd = createTasksDepsAddCommand(() => service);

    await cmd.execute({ taskId: CHILD_ID, task: undefined, dependsOn: DEP_ID });
    await cmd.execute({ taskId: undefined, task: CHILD_ID, dependsOn: DEP_ID });

    // both param names reach addDependency with (dependentTask, dependency)
    expect(addCalls).toEqual([
      [CHILD_ID, DEP_ID],
      [CHILD_ID, DEP_ID],
    ]);
  });

  test("tasks.deps.add rejects a call with neither taskId nor task", async () => {
    const service = {
      addDependency: async () => {
        throw new Error("should not be reached");
      },
    } as unknown as TaskGraphService;
    await expect(
      createTasksDepsAddCommand(() => service).execute({
        taskId: undefined,
        task: undefined,
        dependsOn: DEP_ID,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("tasks.deps.rm resolves taskId (and the task alias) into removeDependency", async () => {
    const rmCalls: Array<[string | undefined, string | undefined]> = [];
    const service = {
      removeDependency: async (a: string, b: string) => {
        rmCalls.push([a, b]);
        return { removed: true };
      },
    } as unknown as TaskGraphService;
    const cmd = createTasksDepsRmCommand(() => service);

    await cmd.execute({ taskId: CHILD_ID, task: undefined, dependsOn: DEP_ID });
    await cmd.execute({ taskId: undefined, task: CHILD_ID, dependsOn: DEP_ID });

    expect(rmCalls).toEqual([
      [CHILD_ID, DEP_ID],
      [CHILD_ID, DEP_ID],
    ]);
  });

  test("tasks.deps.list resolves taskId (and the task alias) into the dependency lookups", async () => {
    const listCalls: Array<string | undefined> = [];
    const service = {
      listDependencies: async (id: string) => {
        listCalls.push(id);
        return [];
      },
      listDependents: async (_id: string) => [],
    } as unknown as TaskGraphService;
    const cmd = createTasksDepsListCommand(() => service);

    await cmd.execute({ taskId: PARENT_ID, task: undefined, verbose: undefined });
    await cmd.execute({ taskId: undefined, task: PARENT_ID, verbose: undefined });

    expect(listCalls).toEqual([PARENT_ID, PARENT_ID]);
  });

  test("tasks.deps.list rejects a call with neither taskId nor task", async () => {
    const service = {
      listDependencies: async () => {
        throw new Error("should not be reached");
      },
      listDependents: async () => [],
    } as unknown as TaskGraphService;
    await expect(
      createTasksDepsListCommand(() => service).execute({
        taskId: undefined,
        task: undefined,
        verbose: undefined,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
