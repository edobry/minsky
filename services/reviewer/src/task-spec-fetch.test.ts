import { describe, expect, test } from "bun:test";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import {
  extractTaskId,
  resolveTaskSpec,
  extractReferencedTaskIds,
  resolveReferencedTaskSpecs,
  MAX_REFERENCED_TASK_SPECS,
} from "./task-spec-fetch";

const SAMPLE_SPEC_BODY = "## Summary\n\nThe spec body.";
const DB_ERROR_MESSAGE = "Database connection failed";

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
        throw new Error(DB_ERROR_MESSAGE);
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
    expect(fetchResult.error).toBe(DB_ERROR_MESSAGE);
  });
});

describe("extractReferencedTaskIds (mt#3919)", () => {
  test("finds a single mt#NNNN reference", () => {
    expect(extractReferencedTaskIds("update task mt#3874's spec/ATs")).toEqual(["mt#3874"]);
  });

  test("finds multiple distinct references in first-occurrence order", () => {
    expect(extractReferencedTaskIds("see mt#10 and mt-20, then mt#10 again")).toEqual([
      "mt#10",
      "mt#20",
    ]);
  });

  test("excludes the self-reference when selfTaskId is provided", () => {
    expect(extractReferencedTaskIds("mt#3915 depends on mt#3874", "mt#3915")).toEqual(["mt#3874"]);
  });

  test("self-exclusion normalizes mt-NNNN and mt#NNNN forms alike", () => {
    expect(extractReferencedTaskIds("see mt#3915 and mt#3874", "mt-3915")).toEqual(["mt#3874"]);
  });

  test("returns [] when the text has no reference", () => {
    expect(extractReferencedTaskIds("no references here")).toEqual([]);
  });

  test("returns [] for empty text", () => {
    expect(extractReferencedTaskIds("")).toEqual([]);
  });

  test("caps at MAX_REFERENCED_TASK_SPECS distinct references", () => {
    const many = Array.from({ length: MAX_REFERENCED_TASK_SPECS + 5 }, (_, i) => `mt#${i}`).join(
      " "
    );
    expect(extractReferencedTaskIds(many)).toHaveLength(MAX_REFERENCED_TASK_SPECS);
  });
});

describe("resolveReferencedTaskSpecs (mt#3919)", () => {
  const CRITERIA_TEXT = "## Success Criteria\n\n- [ ] mt#3874's spec must be updated.";

  test("returns [] when taskSpec is null", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: null,
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("returns [] when taskSpec has no mt#NNNN references", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: "## Success Criteria\n\n- [ ] no references here.",
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("excludes the bound task's own id", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: "mt#3915 says: see also mt#3915 for context.",
      boundTaskId: "mt#3915",
      taskService: makeTaskService(SAMPLE_SPEC_BODY),
    });
    expect(results).toEqual([]);
  });

  test("returns a `disabled` entry per reference when taskService is absent — the model still SEES the reference", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: null,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("disabled");
  });

  test("returns `found` with content + updatedAt when the referenced spec fetches successfully", async () => {
    const updatedAt = new Date("2026-08-10T17:53:58.889Z");
    const taskService = {
      getTaskSpecContent: async (taskId: string) => {
        expect(taskId).toBe("mt#3874");
        return {
          task: { updatedAt } as never,
          specPath: "/fake/mt-3874.md",
          content: "## Success Criteria\n\n- [ ] scoped package name.",
        };
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBe("## Success Criteria\n\n- [ ] scoped package name.");
    expect(results[0]?.updatedAt).toBe("2026-08-10T17:53:58.889Z");
    expect(results[0]?.fetchResult.status).toBe("found");
  });

  test("returns `not-found` when the referenced task's spec content is empty", async () => {
    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: makeTaskService(null),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("mt#3874");
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("not-found");
  });

  test("returns `error` with message when the TaskService throws unexpectedly", async () => {
    const errorService = {
      getTaskSpecContent: async (_taskId: string) => {
        throw new Error(DB_ERROR_MESSAGE);
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: CRITERIA_TEXT,
      boundTaskId: "mt#3915",
      taskService: errorService,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBeNull();
    expect(results[0]?.fetchResult.status).toBe("error");
    expect(results[0]?.fetchResult.error).toBe(DB_ERROR_MESSAGE);
  });

  test("resolves multiple distinct references independently", async () => {
    const specs: Record<string, string | null> = {
      "mt#3874": "found content",
      "mt#9999": null,
    };
    const taskService = {
      getTaskSpecContent: async (taskId: string) => {
        const content = specs[taskId] ?? null;
        if (content === null) throw new Error("task not found");
        return { task: {} as never, specPath: "/fake", content };
      },
    } as unknown as TaskServiceInterface;

    const results = await resolveReferencedTaskSpecs({
      taskSpec: "see mt#3874 and mt#9999",
      boundTaskId: "mt#3915",
      taskService,
    });

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.taskId === "mt#3874")?.fetchResult.status).toBe("found");
    expect(results.find((r) => r.taskId === "mt#9999")?.fetchResult.status).toBe("not-found");
  });
});
