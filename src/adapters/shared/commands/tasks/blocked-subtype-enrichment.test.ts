/**
 * Tests for BLOCKED subtype enrichment in tasks_list and tasks_get.
 *
 * Verifies that:
 *   - tasks_list renders BLOCKED(subtype) when an open Ask exists
 *   - tasks_list renders plain BLOCKED when no open Ask exists
 *   - tasks_get returns blockingAsk when one exists
 *   - tasks_get returns no blockingAsk when none exists
 *   - all four kind→subtype mappings work end-to-end
 *
 * All tests use FakeAskRepository — hermetic, no real DB.
 *
 * Reference: mt#1072, ADR-008 §Task-lifecycle integration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { TasksListCommand, TasksGetCommand } from "./crud-commands";
import { FakeAskRepository } from "../../../../domain/ask/repository";
import type { AskRepository } from "../../../../domain/ask/repository";
import type { Ask, AskKind } from "../../../../domain/ask/types";
import type { CommandExecutionContext } from "../../command-registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUESTOR = "com.anthropic.claude-code:proc:test-agent";
const BLOCKED_TASK_ID = "mt#100";
const NON_BLOCKED_TASK_ID = "mt#200";
const NO_ASK_TASK_ID = "mt#300";
const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";

/** A minimal task object as returned by the domain layer. */
function makeTask(id: string, status: string) {
  return { id, title: `Task ${id}`, status };
}

/** Build an Ask in the "detected" state for the given task. */
function makeAsk(overrides: Partial<Ask> & { kind: AskKind; parentTaskId: string }): Ask {
  return {
    id: `ask-${overrides.kind}-${overrides.parentTaskId}`,
    classifierVersion: "v1.0.0",
    state: "detected",
    requestor: REQUESTOR,
    title: "Test ask",
    question: "What to do?",
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

/** Minimal CommandExecutionContext — format defaults to "text". */
const TEXT_CTX: CommandExecutionContext = { format: "text" } as CommandExecutionContext;
const JSON_CTX: CommandExecutionContext = { format: "json" } as CommandExecutionContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock TaskService whose listTasks returns a fixed task list.
 * Used to supply tasks to TasksListCommand and TasksGetCommand without
 * touching the filesystem or a real DB.
 */
function makeMockTaskService(tasks: ReturnType<typeof makeTask>[]) {
  return {
    listTasks: async () => tasks,
    getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
    getTaskStatus: async () => null,
    setTaskStatus: async () => {},
    createTask: async () => ({ id: "mt#999", title: "new", status: "TODO" }),
    deleteTask: async () => false,
    getWorkspacePath: () => "/tmp/test",
    backends: [],
    currentBackend: "test",
    createTaskFromTitleAndSpec: async () => ({ id: "mt#999", title: "new", status: "TODO" }),
    getTasks: async (ids: string[]) => tasks.filter((t) => ids.includes(t.id)),
  };
}

/**
 * Build a getAskRepository factory that wraps a FakeAskRepository.
 */
function makeGetAskRepo(repo: AskRepository): () => Promise<AskRepository | null> {
  return async () => repo;
}

// ---------------------------------------------------------------------------
// TasksListCommand — BLOCKED subtype enrichment
// ---------------------------------------------------------------------------

describe("TasksListCommand — BLOCKED subtype enrichment", () => {
  let fakeRepo: FakeAskRepository;

  beforeEach(() => {
    fakeRepo = new FakeAskRepository();
  });

  it("renders BLOCKED(direction) for a BLOCKED task with direction.decide ask", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: KIND_DIRECTION_DECIDE, parentTaskId: BLOCKED_TASK_ID, id: "ask-dir" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED"), makeTask(NON_BLOCKED_TASK_ID, "READY")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    // Text result is a string (from formatResult)
    expect(typeof result).toBe("string");
    const text = String(result);
    expect(text).toContain(`BLOCKED(direction)`);
    expect(text).not.toContain(`BLOCKED(other)`);
  });

  it("renders BLOCKED(review) for a BLOCKED task with quality.review ask", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: "quality.review", parentTaskId: BLOCKED_TASK_ID, id: "ask-rev" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    expect(String(result)).toContain("BLOCKED(review)");
  });

  it("renders BLOCKED(authorization) for a BLOCKED task with authorization.approve ask", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: "authorization.approve", parentTaskId: BLOCKED_TASK_ID, id: "ask-auth" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    expect(String(result)).toContain("BLOCKED(authorization)");
  });

  it("renders BLOCKED(other) for a BLOCKED task with no matching kind", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: "stuck.unblock", parentTaskId: BLOCKED_TASK_ID, id: "ask-stuck" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    expect(String(result)).toContain("BLOCKED(other)");
  });

  it("renders plain BLOCKED when no open Ask exists for the task", async () => {
    const tasks = [makeTask(NO_ASK_TASK_ID, "BLOCKED")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    // Should render BLOCKED(other) because no ask → subtype is "other"
    // Per spec: "Other kinds OR no open ask → 'other'"
    expect(String(result)).toContain("BLOCKED(other)");
  });

  it("does not corrupt non-BLOCKED task status in text output", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: KIND_DIRECTION_DECIDE, parentTaskId: BLOCKED_TASK_ID, id: "ask-dir" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED"), makeTask(NON_BLOCKED_TASK_ID, "READY")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    const text = String(result);
    expect(text).toContain("[READY]");
  });

  it("adds blockingAsk field in JSON output when open Ask exists", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: KIND_DIRECTION_DECIDE, parentTaskId: BLOCKED_TASK_ID, id: "ask-dir" })
    );

    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED"), makeTask(NON_BLOCKED_TASK_ID, "READY")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: true } as any, JSON_CTX);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<Record<string, unknown>>;
    const blocked = arr.find((t) => t.id === BLOCKED_TASK_ID);
    expect(blocked?.blockingAsk).toBeDefined();
    expect((blocked?.blockingAsk as any)?.kind).toBe(KIND_DIRECTION_DECIDE);
    expect((blocked?.blockingAsk as any)?.id).toBe("ask-dir");

    // Non-blocked tasks should not have blockingAsk
    const ready = arr.find((t) => t.id === NON_BLOCKED_TASK_ID);
    expect(ready?.blockingAsk).toBeUndefined();
  });

  it("does not add blockingAsk in JSON output when no open Ask exists", async () => {
    const tasks = [makeTask(NO_ASK_TASK_ID, "BLOCKED")];
    const cmd = new TasksListCommand(
      undefined,
      undefined,
      () => makeMockTaskService(tasks) as any,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ json: true } as any, JSON_CTX);
    const arr = result as Array<Record<string, unknown>>;
    const task = arr.find((t) => t.id === NO_ASK_TASK_ID);
    expect(task?.blockingAsk).toBeUndefined();
  });

  it("works correctly when no getAskRepository is provided (backward compat)", async () => {
    const tasks = [makeTask(BLOCKED_TASK_ID, "BLOCKED")];
    // Constructor: no getAskRepository
    const cmd = new TasksListCommand(undefined, undefined, () => makeMockTaskService(tasks) as any);

    const result = await cmd.execute({ json: false } as any, TEXT_CTX);
    // Should render as plain BLOCKED — no crash, graceful fallback
    expect(String(result)).toContain("[BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// TasksGetCommand — blockingAsk enrichment
// ---------------------------------------------------------------------------

describe("TasksGetCommand — blockingAsk enrichment", () => {
  let fakeRepo: FakeAskRepository;

  beforeEach(() => {
    fakeRepo = new FakeAskRepository();
  });

  it("returns blockingAsk when task is BLOCKED and open Ask exists", async () => {
    fakeRepo._seedAtState(
      makeAsk({ kind: KIND_DIRECTION_DECIDE, parentTaskId: BLOCKED_TASK_ID, id: "ask-dir" })
    );

    const task = makeTask(BLOCKED_TASK_ID, "BLOCKED");
    const cmd = new TasksGetCommand(
      undefined,
      undefined,
      () => makeMockTaskService([task]) as any,
      undefined,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ taskId: BLOCKED_TASK_ID, json: true } as any, JSON_CTX);
    const resultObj = result as Record<string, unknown>;
    expect(resultObj.blockingAsk).toBeDefined();
    const blockingAsk = resultObj.blockingAsk as Record<string, unknown>;
    expect(blockingAsk.kind).toBe(KIND_DIRECTION_DECIDE);
    expect(blockingAsk.id).toBe("ask-dir");
  });

  it("returns no blockingAsk when task is BLOCKED but no open Ask exists", async () => {
    const task = makeTask(NO_ASK_TASK_ID, "BLOCKED");
    const cmd = new TasksGetCommand(
      undefined,
      undefined,
      () => makeMockTaskService([task]) as any,
      undefined,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ taskId: NO_ASK_TASK_ID, json: true } as any, JSON_CTX);
    const resultObj = result as Record<string, unknown>;
    expect(resultObj.blockingAsk).toBeUndefined();
  });

  it("returns no blockingAsk when task is not BLOCKED", async () => {
    fakeRepo._seedAtState(
      makeAsk({
        kind: KIND_DIRECTION_DECIDE,
        parentTaskId: NON_BLOCKED_TASK_ID,
        id: "ask-for-ready",
      })
    );

    const task = makeTask(NON_BLOCKED_TASK_ID, "READY");
    const cmd = new TasksGetCommand(
      undefined,
      undefined,
      () => makeMockTaskService([task]) as any,
      undefined,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ taskId: NON_BLOCKED_TASK_ID, json: true } as any, JSON_CTX);
    const resultObj = result as Record<string, unknown>;
    expect(resultObj.blockingAsk).toBeUndefined();
  });

  it("includes deadline in blockingAsk when the Ask has one", async () => {
    const deadline = "2025-12-31T00:00:00.000Z";
    fakeRepo._seedAtState(
      makeAsk({
        kind: "authorization.approve",
        parentTaskId: BLOCKED_TASK_ID,
        id: "ask-auth",
        deadline,
      })
    );

    const task = makeTask(BLOCKED_TASK_ID, "BLOCKED");
    const cmd = new TasksGetCommand(
      undefined,
      undefined,
      () => makeMockTaskService([task]) as any,
      undefined,
      makeGetAskRepo(fakeRepo)
    );

    const result = await cmd.execute({ taskId: BLOCKED_TASK_ID, json: true } as any, JSON_CTX);
    const resultObj = result as Record<string, unknown>;
    const blockingAsk = resultObj.blockingAsk as Record<string, unknown>;
    expect(blockingAsk.deadline).toBe(deadline);
  });

  it("works correctly when no getAskRepository is provided (backward compat)", async () => {
    const task = makeTask(BLOCKED_TASK_ID, "BLOCKED");
    // Constructor: no getAskRepository
    const cmd = new TasksGetCommand(undefined, undefined, () => makeMockTaskService([task]) as any);

    const result = await cmd.execute({ taskId: BLOCKED_TASK_ID, json: true } as any, JSON_CTX);
    const resultObj = result as Record<string, unknown>;
    // Should complete without error and without blockingAsk
    expect(resultObj.blockingAsk).toBeUndefined();
  });
});
