/**
 * Regression tests for the tasks_children / tasks_parent param-name fix (mt#2737).
 *
 * The bug: these two commands named their param `task` while the rest of the
 * tasks_* family uses `taskId`. A caller following convention passed `taskId`,
 * so `params.task` arrived undefined and the relationship query ran with an
 * undefined bind (UNDEFINED_VALUE). The fix renames the param to `taskId`.
 *
 * These tests assert the provided `taskId` reaches the TaskGraphService call —
 * they FAIL if the id is ever again dropped before the query (the captured call
 * arg would be undefined instead of the expected id). A throwing-stub service
 * keeps this a pure command-boundary unit test (no DB, no module mocking).
 */

import { describe, test, expect } from "bun:test";
import { createTasksChildrenCommand, createTasksParentCommand } from "./deps-commands";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";

const PARENT_ID = "mt#1552";
const CHILD_ID = "mt#2739";

describe("tasks_children / tasks_parent taskId threading (mt#2737)", () => {
  test("tasks.children threads params.taskId into service.listChildren", async () => {
    const calls: Array<string | undefined> = [];
    const service = {
      listChildren: async (id: string) => {
        calls.push(id);
        return ["mt#100", "mt#101"];
      },
    } as unknown as TaskGraphService;

    const cmd = createTasksChildrenCommand(() => service);
    const result = await cmd.execute({ taskId: PARENT_ID });

    // The provided id must reach the service — [undefined] here is the bug.
    expect(calls).toEqual([PARENT_ID]);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${PARENT_ID}: 2 subtask(s)`);
  });

  test("tasks.children reports no subtasks when the service returns none", async () => {
    const calls: Array<string | undefined> = [];
    const service = {
      listChildren: async (id: string) => {
        calls.push(id);
        return [];
      },
    } as unknown as TaskGraphService;

    const result = await createTasksChildrenCommand(() => service).execute({ taskId: PARENT_ID });

    expect(calls).toEqual([PARENT_ID]);
    expect(result.output).toContain(`${PARENT_ID}: no subtasks`);
  });

  test("tasks.parent threads params.taskId into service.getParent", async () => {
    const calls: Array<string | undefined> = [];
    const service = {
      getParent: async (id: string) => {
        calls.push(id);
        return PARENT_ID;
      },
    } as unknown as TaskGraphService;

    const cmd = createTasksParentCommand(() => service);
    const result = await cmd.execute({ taskId: CHILD_ID });

    expect(calls).toEqual([CHILD_ID]);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`${CHILD_ID}: parent is ${PARENT_ID}`);
  });

  test("tasks.parent reports a root task when the service returns null", async () => {
    const calls: Array<string | undefined> = [];
    const service = {
      getParent: async (id: string) => {
        calls.push(id);
        return null;
      },
    } as unknown as TaskGraphService;

    const result = await createTasksParentCommand(() => service).execute({ taskId: CHILD_ID });

    expect(calls).toEqual([CHILD_ID]);
    expect(result.output).toContain(`${CHILD_ID}: no parent (root task)`);
  });
});
