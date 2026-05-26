import { describe, expect, test } from "bun:test";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import { extractTaskId, resolveTaskSpec } from "./task-spec-fetch";

const SAMPLE_SPEC_BODY = "## Summary\n\nThe spec body.";

/**
 * Build a minimal fake TaskServiceInterface for task-spec-fetch tests.
 * Only getTaskSpecContent is relevant here.
 */
function makeTaskService(spec: string | null): TaskServiceInterface {
  return {
    getTaskSpecContent: async (_taskId: string) => {
      if (spec === null) {
        throw new Error("task not found");
      }
      return { task: {} as never, specPath: "/fake/path", content: spec };
    },
  } as unknown as TaskServiceInterface;
}

describe("extractTaskId", () => {
  test("pulls mt#NNNN from a task/mt-XXXX branch name", () => {
    expect(extractTaskId({ branchName: "task/mt-1187", prTitle: "" })).toBe("mt#1187");
  });

  test("pulls mt#NNNN from a feat(mt#XXXX): PR title", () => {
    expect(extractTaskId({ branchName: "", prTitle: "feat(mt#1110): calibrate reviewer" })).toBe(
      "mt#1110"
    );
  });

  test("matches the [mt-NNNN] bracket form", () => {
    expect(extractTaskId({ branchName: "", prTitle: "[mt-42] cleanup" })).toBe("mt#42");
  });

  test("branch name takes priority over title when both match", () => {
    expect(extractTaskId({ branchName: "task/mt-1187", prTitle: "mt-999 something" })).toBe(
      "mt#1187"
    );
  });

  test("falls back to title when branch has no match", () => {
    expect(extractTaskId({ branchName: "main", prTitle: "fix(mt#555): x" })).toBe("mt#555");
  });

  test("returns null when neither has a match", () => {
    expect(extractTaskId({ branchName: "main", prTitle: "misc cleanup" })).toBeNull();
  });

  test("returns null on null inputs", () => {
    expect(extractTaskId({ branchName: null, prTitle: null })).toBeNull();
  });

  test("is case-insensitive on the mt prefix", () => {
    expect(extractTaskId({ branchName: "task/MT-77", prTitle: "" })).toBe("mt#77");
  });

  test("does not match mid-word false positives (word boundary)", () => {
    expect(extractTaskId({ branchName: "fmt-1234", prTitle: "" })).toBeNull();
    expect(extractTaskId({ branchName: "", prTitle: "bump amount-123" })).toBeNull();
    expect(extractTaskId({ branchName: "", prTitle: "drop comment-99" })).toBeNull();
  });
});

describe("resolveTaskSpec", () => {
  test("returns disabled when taskService is absent (null)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      taskService: null,
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
    expect(fetchResult.taskId).toBeUndefined();
  });

  test("returns disabled when taskService is absent (undefined)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
  });

  test("returns no-task-id when no mt# reference is in branch or title", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "main",
      prTitle: "misc cleanup",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("no-task-id");
  });

  test("returns found with specLength when the TaskService returns content", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(taskSpec).toBe(SAMPLE_SPEC_BODY);
    expect(fetchResult.status).toBe("found");
    expect(fetchResult.taskId).toBe("mt#1187");
    expect(fetchResult.specLength).toBe(SAMPLE_SPEC_BODY.length);
  });

  test("returns not-found when the TaskService returns null content", async () => {
    // makeTaskService(null) throws a "task not found" error — which resolveTaskSpec
    // maps to not-found via the /not.found|does not exist|no such/i regex.
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-9999",
      prTitle: "",
      taskService: makeTaskService(null),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("not-found");
    expect(fetchResult.taskId).toBe("mt#9999");
  });

  test("returns error with message when the TaskService throws an unexpected error", async () => {
    const errorService = {
      getTaskSpecContent: async (_taskId: string) => {
        throw new Error("Database connection failed");
      },
    } as unknown as TaskServiceInterface;

    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-42",
      prTitle: "",
      taskService: errorService,
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("error");
    expect(fetchResult.taskId).toBe("mt#42");
    expect(fetchResult.error).toBe("Database connection failed");
  });
});
