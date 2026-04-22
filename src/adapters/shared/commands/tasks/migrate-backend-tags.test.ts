/**
 * Regression test: tag preservation during backend migration
 *
 * Bug mt#758: migrate-backend command called createTaskFromTitleAndSpec
 * without passing fullTask.tags, silently dropping tags during migration.
 *
 * Fixed by adding `tags: fullTask.tags` to the CreateTaskOptions.
 * This test ensures the fix is not accidentally reverted.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TasksMigrateBackendCommand } from "./migrate-backend-command";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";

describe("Migration Tag Preservation (mt#758 regression)", () => {
  const SOURCE_TASK = {
    id: "mt#100",
    title: "Test task with tags",
    status: "TODO",
    tags: ["di-cleanup", "test-quality"],
  };

  let command: TasksMigrateBackendCommand;
  let mockCreateTaskFromTitleAndSpec: ReturnType<typeof mock>;

  beforeEach(() => {
    command = new TasksMigrateBackendCommand();

    mockCreateTaskFromTitleAndSpec = mock(async () => ({
      id: "gh#100",
      title: SOURCE_TASK.title,
      status: "TODO",
    }));

    // Inject fake service factory via DI seam (public field on command)

    (command as any).createTaskServiceFactory = mock(async (options: { backend?: string }) => {
      if (options.backend === "github") {
        return {
          listTasks: mock(async () => []),
          getTask: mock(async () => null),
          getTaskStatus: mock(async () => undefined),
          setTaskStatus: mock(async () => {}),
          createTaskFromTitleAndSpec: mockCreateTaskFromTitleAndSpec,
          deleteTask: mock(async () => false),
          getWorkspacePath: () => "/mock",
          getCapabilities: () => ({ canCreate: true }),
          getTaskSpecContent: mock(async () => ({ task: null, specPath: "", content: "" })),
          listBackends: () => [{ name: "github", prefix: "gh" }],
        } as unknown as TaskServiceInterface;
      }
      return {
        listTasks: mock(async () => [SOURCE_TASK]),
        getTask: mock(async () => SOURCE_TASK),
        getTaskStatus: mock(async () => "TODO"),
        setTaskStatus: mock(async () => {}),
        createTaskFromTitleAndSpec: mock(async () => SOURCE_TASK),
        deleteTask: mock(async () => false),
        getWorkspacePath: () => "/mock",
        getCapabilities: () => ({ canCreate: true }),
        getTaskSpecContent: mock(async () => ({
          task: SOURCE_TASK,
          specPath: "/mock/spec.md",
          content: "Test spec",
        })),
        listBackends: () => [{ name: "minsky", prefix: "mt" }],
      } as unknown as TaskServiceInterface;
    });
  });

  it("should pass tags through to target backend during migration", async () => {
    const result = await (command as any).migrateTasksBetweenBackends({
      sourceBackend: "minsky",
      targetBackend: "github",
      workspacePath: "/mock",
      dryRun: false,
      updateIds: true,
      persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
    });

    expect(result.migrated).toBe(1);
    expect(result.errors).toBe(0);

    // THE KEY ASSERTION: createTaskFromTitleAndSpec must receive tags
    expect(mockCreateTaskFromTitleAndSpec).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateTaskFromTitleAndSpec.mock.calls[0];
    const options = callArgs?.[2] as { tags?: string[] } | undefined;

    expect(options).toBeDefined();
    expect(options?.tags).toEqual(["di-cleanup", "test-quality"]);
  });

  it("should handle tasks without tags gracefully", async () => {
    const taskWithoutTags = { id: "mt#200", title: "No tags", status: "TODO" };

    (command as any).createTaskServiceFactory = mock(async (options: { backend?: string }) => {
      if (options.backend === "github") {
        return {
          listTasks: mock(async () => []),
          getTask: mock(async () => null),
          getTaskStatus: mock(async () => undefined),
          setTaskStatus: mock(async () => {}),
          createTaskFromTitleAndSpec: mockCreateTaskFromTitleAndSpec,
          deleteTask: mock(async () => false),
          getWorkspacePath: () => "/mock",
          getCapabilities: () => ({ canCreate: true }),
          getTaskSpecContent: mock(async () => ({ task: null, specPath: "", content: "" })),
          listBackends: () => [{ name: "github", prefix: "gh" }],
        } as unknown as TaskServiceInterface;
      }
      return {
        listTasks: mock(async () => [taskWithoutTags]),
        getTask: mock(async () => taskWithoutTags),
        getTaskStatus: mock(async () => "TODO"),
        setTaskStatus: mock(async () => {}),
        createTaskFromTitleAndSpec: mock(async () => taskWithoutTags),
        deleteTask: mock(async () => false),
        getWorkspacePath: () => "/mock",
        getCapabilities: () => ({ canCreate: true }),
        getTaskSpecContent: mock(async () => ({
          task: taskWithoutTags,
          specPath: "",
          content: "",
        })),
        listBackends: () => [{ name: "minsky", prefix: "mt" }],
      } as unknown as TaskServiceInterface;
    });

    const result = await (command as any).migrateTasksBetweenBackends({
      sourceBackend: "minsky",
      targetBackend: "github",
      workspacePath: "/mock",
      dryRun: false,
      updateIds: true,
      persistenceProvider: { capabilities: { sql: false, vector: false } } as any,
    });

    expect(result.migrated).toBe(1);

    const callArgs = mockCreateTaskFromTitleAndSpec.mock.calls[0];
    const options = callArgs?.[2] as { tags?: string[] } | undefined;
    expect(options?.tags).toBeUndefined();
  });
});
