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
import { createTasksChildrenCommand, createTasksParentCommand } from "./deps-commands";
import { ValidationError } from "@minsky/domain/errors/index";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";

const PARENT_ID = "mt#1552";
const CHILD_ID = "mt#2739";

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
