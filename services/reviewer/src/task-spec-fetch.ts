/**
 * Task-spec resolution for the reviewer service.
 *
 * Two responsibilities:
 *   1. Extract the task ID from a PR's branch name or title.
 *   2. Call the hosted Minsky MCP (via mcp-client.ts) and classify the
 *      outcome into a structured TaskSpecFetchResult the caller logs.
 *
 * The actual HTTP work lives in mcp-client.ts (alongside the provenance
 * client that mt#1085 shipped). This module is a thin adapter that maps
 * the MCP-client result shape onto the reviewer's logging taxonomy.
 *
 * Requires the hosted MCP to be reachable with a populated tasks table;
 * transport issues surface as `status: "error"`, missing config as
 * `status: "disabled"`, and operator visibility is preserved via logs.
 */

import type { ReviewerConfig } from "./config";
import { callTasksSpecGet, type TasksSpecGetResult } from "./mcp-client";

/**
 * Matches task IDs in common branch/title forms: `task/mt-1109`, `mt#1109`,
 * `feat(mt#1109): ...`, `[mt-1109]`. Leading `\b` prevents mid-word matches
 * like `fmt-1234`.
 */
const TASK_ID_RE = /\bmt[#-](\d+)/i;

export function extractTaskId(input: {
  branchName?: string | null;
  prTitle?: string | null;
}): string | null {
  const candidates = [input.branchName, input.prTitle].filter(
    (s): s is string => typeof s === "string"
  );
  for (const s of candidates) {
    const m = TASK_ID_RE.exec(s);
    if (m) return `mt#${m[1]}`;
  }
  return null;
}

/**
 * Outcome of the task-spec fetch for a single review. Recorded in the result
 * so server logs can show whether the reviewer had spec access. Useful when
 * diagnosing calibration regressions (mt#1110).
 */
export interface TaskSpecFetchResult {
  status: "found" | "no-task-id" | "not-found" | "disabled" | "error";
  taskId?: string;
  specLength?: number;
  error?: string;
}

/**
 * Injected dependency for tests. Defaults to the production callTasksSpecGet.
 * Tests pass a stub that returns a hardcoded TasksSpecGetResult instead of
 * making a real HTTP request.
 */
export type TasksSpecGetFn = (
  taskId: string,
  config: ReviewerConfig
) => Promise<TasksSpecGetResult>;

/**
 * Resolve the task spec for a PR. Extracts the task ID from branch + title,
 * then calls the MCP. Every non-success path returns `taskSpec: null` with a
 * structured `fetchResult` — the reviewer never blocks on spec fetch.
 */
export async function resolveTaskSpec(input: {
  branchName: string;
  prTitle: string;
  config: ReviewerConfig;
  fetcher?: TasksSpecGetFn;
}): Promise<{ taskSpec: string | null; fetchResult: TaskSpecFetchResult }> {
  if (!input.config.mcpUrl || !input.config.mcpToken) {
    return {
      taskSpec: null,
      fetchResult: { status: "disabled" },
    };
  }

  const taskId = extractTaskId({
    branchName: input.branchName,
    prTitle: input.prTitle,
  });
  if (!taskId) {
    return {
      taskSpec: null,
      fetchResult: { status: "no-task-id" },
    };
  }

  const fetcher = input.fetcher ?? callTasksSpecGet;
  const result = await fetcher(taskId, input.config);
  switch (result.kind) {
    case "found":
      return {
        taskSpec: result.content,
        fetchResult: { status: "found", taskId, specLength: result.content.length },
      };
    case "not-found":
      return {
        taskSpec: null,
        fetchResult: { status: "not-found", taskId },
      };
    case "disabled":
      // Shouldn't reach here given the config check above, but handle defensively.
      return {
        taskSpec: null,
        fetchResult: { status: "disabled" },
      };
    case "error":
      return {
        taskSpec: null,
        fetchResult: { status: "error", taskId, error: result.message },
      };
  }
}
