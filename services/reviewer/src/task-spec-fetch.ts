/**
 * Task-spec resolution for the reviewer service.
 *
 * Two responsibilities:
 *   1. Extract the task ID from a PR's branch name or title.
 *   2. Fetch the task spec content via the injected TaskServiceInterface and
 *      classify the outcome into a structured TaskSpecFetchResult the caller logs.
 *
 * Previously called the hosted Minsky MCP via mcp-client.ts. Now uses the
 * domain TaskServiceInterface directly (mt#2121).
 *
 * Requires a running TaskService with a backend configured for the repo;
 * transport issues surface as `status: "error"`, missing service as
 * `status: "disabled"`, and operator visibility is preserved via logs.
 */

import type { TaskServiceInterface } from "@minsky/domain/tasks";

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
 * Resolve the task spec for a PR. Extracts the task ID from branch + title,
 * then fetches the spec via the TaskService. Every non-success path returns
 * `taskSpec: null` with a structured `fetchResult` — the reviewer never
 * blocks on spec fetch.
 *
 * @param taskService Optional injected TaskService. When absent, returns
 *   `status: "disabled"` — the spec fetch is optional and the reviewer
 *   degrades gracefully without it.
 */
export async function resolveTaskSpec(input: {
  branchName: string;
  prTitle: string;
  taskService?: TaskServiceInterface | null;
}): Promise<{ taskSpec: string | null; fetchResult: TaskSpecFetchResult }> {
  if (!input.taskService) {
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

  try {
    const result = await input.taskService.getTaskSpecContent(taskId);
    const content = result.content;
    if (!content) {
      return {
        taskSpec: null,
        fetchResult: { status: "not-found", taskId },
      };
    }
    return {
      taskSpec: content,
      fetchResult: { status: "found", taskId, specLength: content.length },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Treat "not found" errors as not-found, everything else as error.
    if (/not.found|does not exist|no such/i.test(message)) {
      return {
        taskSpec: null,
        fetchResult: { status: "not-found", taskId },
      };
    }
    return {
      taskSpec: null,
      fetchResult: { status: "error", taskId, error: message },
    };
  }
}
