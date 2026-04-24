import { describe, expect, test } from "bun:test";
import type { ReviewerConfig } from "./config";
import type { TasksSpecGetResult } from "./mcp-client";
import { extractTaskId, resolveTaskSpec, type TasksSpecGetFn } from "./task-spec-fetch";

const SAMPLE_SPEC_BODY = "## Summary\n\nThe spec body.";

const baseConfig: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "",
  providerModel: "gpt-5",
  tier2Enabled: true,
  mcpUrl: "https://mcp.example/mcp",
  mcpToken: "token",
  port: 3000,
  logLevel: "info",
};

const stubFetcher =
  (result: TasksSpecGetResult): TasksSpecGetFn =>
  async () =>
    result;

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
  test("returns disabled when MCP config is missing (no URL)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      config: { ...baseConfig, mcpUrl: undefined },
      fetcher: stubFetcher({ kind: "found", content: SAMPLE_SPEC_BODY }),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
    expect(fetchResult.taskId).toBeUndefined();
  });

  test("returns disabled when MCP config is missing (no token)", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      config: { ...baseConfig, mcpToken: undefined },
      fetcher: stubFetcher({ kind: "found", content: SAMPLE_SPEC_BODY }),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("disabled");
  });

  test("returns no-task-id when no mt# reference is in branch or title", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "main",
      prTitle: "misc cleanup",
      config: baseConfig,
      fetcher: stubFetcher({ kind: "found", content: SAMPLE_SPEC_BODY }),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("no-task-id");
  });

  test("returns found with specLength when the MCP returns content", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-1187",
      prTitle: "",
      config: baseConfig,
      fetcher: stubFetcher({ kind: "found", content: SAMPLE_SPEC_BODY }),
    });
    expect(taskSpec).toBe(SAMPLE_SPEC_BODY);
    expect(fetchResult.status).toBe("found");
    expect(fetchResult.taskId).toBe("mt#1187");
    expect(fetchResult.specLength).toBe(SAMPLE_SPEC_BODY.length);
  });

  test("returns not-found when the MCP returns no content for the task", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-9999",
      prTitle: "",
      config: baseConfig,
      fetcher: stubFetcher({ kind: "not-found" }),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("not-found");
    expect(fetchResult.taskId).toBe("mt#9999");
  });

  test("returns error with message when the MCP returns an error", async () => {
    const { taskSpec, fetchResult } = await resolveTaskSpec({
      branchName: "task/mt-42",
      prTitle: "",
      config: baseConfig,
      fetcher: stubFetcher({ kind: "error", message: "Developer setup incomplete" }),
    });
    expect(taskSpec).toBeNull();
    expect(fetchResult.status).toBe("error");
    expect(fetchResult.taskId).toBe("mt#42");
    expect(fetchResult.error).toBe("Developer setup incomplete");
  });
});
