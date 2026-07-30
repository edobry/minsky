/**
 * Convergence tests for tasks.similar / tasks.search (mt#3305).
 *
 * These two commands are ONE operation behind two front doors: `similarToTask`
 * turns a task into query text and delegates to `searchByText`. They had drifted
 * independently, and every defect mt#3305 fixed lived in that gap:
 *
 *   - `all` existed on search and not on similar, so similar could not be asked
 *     to include shipped work by any argument.
 *   - `threshold` was declared on both and applied by neither.
 *   - similar passed no filters at all, so its results were shaped by whatever
 *     the live cross-check happened to contain.
 *
 * The tests below pin the two properties that keep them converged: identical
 * PARAMETER SURFACE, and DEFAULTS that differ deliberately rather than by
 * accident.
 */
import { describe, test, expect } from "bun:test";
import { TasksSimilarCommand, TasksSearchCommand } from "./similarity-commands";
import { tasksSimilarParams, tasksSearchParams } from "./task-parameters";
import type { CommandExecutionContext, InferParams } from "../../command-registry";

const ctx = { interface: "test", format: "cli" } as CommandExecutionContext;

const emptyResponse = { results: [], backend: "embeddings" as const, degraded: false };

/** Captures the arguments each command hands to the shared service. */
function captureSimilarCall() {
  const calls: Array<{ threshold?: number; filters?: Record<string, unknown> }> = [];
  const cmd = new TasksSimilarCommand(
    () => ({}) as never,
    () => undefined as never
  );
  (cmd as unknown as { createService: () => Promise<unknown> }).createService = async () => ({
    similarToTask: async (
      _taskId: string,
      _limit: number,
      threshold?: number,
      _scope?: unknown,
      filters?: Record<string, unknown>
    ) => {
      calls.push({ threshold, filters });
      return emptyResponse;
    },
  });
  return { cmd, calls };
}

function captureSearchCall() {
  const calls: Array<{ threshold?: number; filters?: Record<string, unknown> }> = [];
  const cmd = new TasksSearchCommand(
    () => ({}) as never,
    () => undefined as never
  );
  (cmd as unknown as { createService: () => Promise<unknown> }).createService = async () => ({
    searchByText: async (
      _query: string,
      _limit: number,
      threshold?: number,
      filters?: Record<string, unknown>
    ) => {
      calls.push({ threshold, filters });
      return emptyResponse;
    },
  });
  return { cmd, calls };
}

describe("tasks.similar / tasks.search parameter parity (mt#3305)", () => {
  // The two commands take different INPUTS by design — a task id vs free text —
  // so those keys are excluded. Everything else is a filter/shaping param and
  // must exist on both, or a caller can express an intent on one door that the
  // other silently cannot honour.
  const INPUT_SPECIFIC = new Set(["taskId", "query"]);

  test("every filter/shaping param on tasks.search also exists on tasks.similar", () => {
    const searchKeys = Object.keys(tasksSearchParams).filter((k) => !INPUT_SPECIFIC.has(k));
    const similarKeys = new Set(Object.keys(tasksSimilarParams));
    const missing = searchKeys.filter((k) => !similarKeys.has(k));
    expect(missing).toEqual([]);
  });

  test("tasks.similar declares `all` — its absence is what made the command unable to see shipped work", () => {
    expect(Object.keys(tasksSimilarParams)).toContain("all");
  });

  test("both declare threshold, and it is forwarded to the shared core rather than dropped", async () => {
    const similar = captureSimilarCall();
    await similar.cmd.execute(
      { taskId: "mt#1", threshold: 0.42 } as InferParams<typeof tasksSimilarParams>,
      ctx
    );
    expect(similar.calls[0]?.threshold).toBe(0.42);

    const search = captureSearchCall();
    await search.cmd.execute(
      { query: "anything", threshold: 0.42 } as InferParams<typeof tasksSearchParams>,
      ctx
    );
    expect(search.calls[0]?.threshold).toBe(0.42);
  });
});

describe("tasks.similar / tasks.search default status behaviour (mt#3305)", () => {
  test("tasks.search excludes terminal statuses by default (browse)", async () => {
    const { cmd, calls } = captureSearchCall();
    await cmd.execute({ query: "anything" } as InferParams<typeof tasksSearchParams>, ctx);
    expect(calls[0]?.filters?.statusExclude).toEqual(["DONE", "CLOSED"]);
  });

  test("tasks.similar does NOT exclude terminal statuses by default (dedupe)", async () => {
    // The acceptance bar for this task. mt#3290 and mt#3352 were both filed as
    // duplicates of tasks that were the NEAREST neighbour in the embedding index
    // but invisible to this command because they were DONE. A duplicate check
    // that hides shipped work cannot do its job.
    const { cmd, calls } = captureSimilarCall();
    await cmd.execute({ taskId: "mt#3271" } as InferParams<typeof tasksSimilarParams>, ctx);
    expect(calls[0]?.filters?.statusExclude).toBeUndefined();
  });

  test("the two defaults are NOT the same — converging them silently would reintroduce the bug", async () => {
    const similar = captureSimilarCall();
    await similar.cmd.execute({ taskId: "mt#1" } as InferParams<typeof tasksSimilarParams>, ctx);
    const search = captureSearchCall();
    await search.cmd.execute({ query: "anything" } as InferParams<typeof tasksSearchParams>, ctx);

    expect(similar.calls[0]?.filters?.statusExclude).not.toEqual(
      search.calls[0]?.filters?.statusExclude
    );
  });

  test("an explicit --status still narrows tasks.similar", async () => {
    const { cmd, calls } = captureSimilarCall();
    await cmd.execute(
      { taskId: "mt#1", status: "TODO" } as InferParams<typeof tasksSimilarParams>,
      ctx
    );
    expect(calls[0]?.filters?.status).toBe("TODO");
  });
});
