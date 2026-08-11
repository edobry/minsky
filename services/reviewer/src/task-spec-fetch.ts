/**
 * Task-spec resolution for the reviewer service.
 *
 * Three responsibilities:
 *   1. Extract the task ID from a PR's branch name or title.
 *   2. Fetch the task spec content via the injected TaskServiceInterface and
 *      classify the outcome into a structured TaskSpecFetchResult the caller logs.
 *   3. Resolve `mt#NNNN` references appearing WITHIN a task spec's text (mt#3919)
 *      — e.g. a success criterion naming another task's spec as its artifact —
 *      so the reviewer can verify that criterion against the referenced spec's
 *      actual content instead of reporting it unmet solely because the artifact
 *      is absent from the diff.
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

// ---------------------------------------------------------------------------
// mt#3919: referenced-task-spec resolution
// ---------------------------------------------------------------------------

/**
 * Matches every `mt#NNNN` / `mt-NNNN` occurrence in free text (global, so it
 * finds ALL references rather than just the first — unlike `TASK_ID_RE`,
 * which `extractTaskId` uses to find a single branch/title match).
 */
const REFERENCED_TASK_ID_RE = /\bmt[#-](\d+)/gi;

/**
 * Upper bound on distinct referenced-task-spec fetches per review (mt#3919).
 *
 * A spec that names more than this many other tasks is pathological — this
 * repo's specs typically reference 0-3. Bounding the fetch count avoids a
 * spec becoming a denial-of-context / denial-of-service vector (N sequential
 * TaskService calls before the review can proceed), mirroring the bound
 * `MAX_BATCHED_SPEC_VERIFICATIONS` already places on the batched submission
 * tool (output-tools.ts).
 */
export const MAX_REFERENCED_TASK_SPECS = 10;

/**
 * Extract every distinct `mt#NNNN` reference from `text`, in first-occurrence
 * order, excluding `selfTaskId` (the bound task referencing its own id is not
 * a "referenced" spec — its content is already injected as the primary Task
 * Specification section) and capped at `MAX_REFERENCED_TASK_SPECS`.
 *
 * Exported for tests; also used by `resolveReferencedTaskSpecs` below.
 */
export function extractReferencedTaskIds(text: string, selfTaskId?: string | null): string[] {
  const selfNormalized = selfTaskId ? normalizeMtId(selfTaskId) : null;
  const seen = new Set<string>();
  const ids: string[] = [];
  // Fresh RegExp instance per call: a module-scoped `g`-flagged regex is
  // stateful across calls via `lastIndex`, which would corrupt results under
  // concurrent or repeated invocations.
  const re = new RegExp(REFERENCED_TASK_ID_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = `mt#${m[1]}`;
    if (selfNormalized !== null && id === selfNormalized) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_REFERENCED_TASK_SPECS) break;
  }
  return ids;
}

/** Normalize an `mt#NNNN` / `mt-NNNN` string to the canonical `mt#NNNN` form. */
function normalizeMtId(taskId: string): string | null {
  const m = /\bmt[#-](\d+)/i.exec(taskId);
  return m ? `mt#${m[1]}` : null;
}

/**
 * Outcome of resolving one `mt#NNNN` reference found inside a task spec's
 * text (mt#3919). Distinct from `TaskSpecFetchResult` only in that it always
 * carries `taskId` (every entry originates from a successfully-extracted
 * reference) and additionally records the referenced task's `updatedAt` —
 * gate (h)'s auditability requirement: a criterion verified against another
 * task's spec depends on mutable DB state, so the verdict should record
 * *when* the evidence was read, not just what it said.
 */
export interface ReferencedTaskSpecResult {
  taskId: string;
  /** Full spec content, or null when the fetch did not succeed. */
  content: string | null;
  /** ISO-8601 `updatedAt` of the referenced task's spec, or null when unavailable. */
  updatedAt: string | null;
  fetchResult: TaskSpecFetchResult;
}

/**
 * Resolve every `mt#NNNN` reference appearing in `taskSpec`'s text (mt#3919).
 *
 * This is the mechanism the mt#3919 Decision section names: the reviewer
 * already calls `taskService.getTaskSpecContent(taskId)` for the BOUND task
 * (via `resolveTaskSpec` above); this function reuses the same injected
 * service to additionally fetch any OTHER task specs a success criterion
 * names as its artifact, so the reviewer can verify that criterion against
 * real content rather than reporting it unmet purely because the artifact is
 * outside the diff.
 *
 * Never blocks and never throws: a fetch failure for one reference (missing
 * task, disabled service, transport error) produces a `content: null` entry
 * with the failure's `fetchResult` — the caller renders this so the model can
 * report the criterion `Unverifiable` (never `Met`, never silently dropped).
 *
 * @param input.taskSpec The bound task's spec text to scan for references.
 *   Null/empty → returns [].
 * @param input.boundTaskId The bound task's own id (from `resolveTaskSpec`'s
 *   `fetchResult.taskId`), excluded from the results — see
 *   `extractReferencedTaskIds`.
 * @param input.taskService Optional injected TaskService. When absent, every
 *   extracted reference is returned with `fetchResult.status: "disabled"` —
 *   the reviewer still SEES that a reference exists (so the model can report
 *   it `Unverifiable` rather than silently ignoring it), it just cannot fetch it.
 */
export async function resolveReferencedTaskSpecs(input: {
  taskSpec: string | null;
  boundTaskId?: string | null;
  taskService?: TaskServiceInterface | null;
}): Promise<ReferencedTaskSpecResult[]> {
  if (!input.taskSpec) return [];

  const refIds = extractReferencedTaskIds(input.taskSpec, input.boundTaskId);
  if (refIds.length === 0) return [];

  if (!input.taskService) {
    return refIds.map((taskId) => ({
      taskId,
      content: null,
      updatedAt: null,
      fetchResult: { status: "disabled", taskId },
    }));
  }

  const results: ReferencedTaskSpecResult[] = [];
  for (const taskId of refIds) {
    try {
      const result = await input.taskService.getTaskSpecContent(taskId);
      const content = result.content;
      if (!content) {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "not-found", taskId },
        });
        continue;
      }
      const updatedAt = result.task?.updatedAt;
      results.push({
        taskId,
        content,
        updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : null,
        fetchResult: { status: "found", taskId, specLength: content.length },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not.found|does not exist|no such/i.test(message)) {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "not-found", taskId },
        });
      } else {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "error", taskId, error: message },
        });
      }
    }
  }
  return results;
}
