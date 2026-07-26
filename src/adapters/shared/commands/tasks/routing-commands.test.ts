/**
 * tasks.available — `limit` / `minReadiness` omission regression tests
 * (mt#2705, confirming the mt#2759 fix + this task's shared-layer fix hold
 * end-to-end).
 *
 * These two params were the spec's CONFIRMED-SILENT wrong-behavior cases
 * (not theoretical):
 *   - `limit: z.number().default(20)` — an omitted `limit` previously made
 *     `.slice(0, undefined)` silently return the UNBOUNDED list instead of
 *     the documented 20-item cap.
 *   - `minReadiness: z.number().min(0).max(1).default(0.5)` — an omitted
 *     `minReadiness` made `task.readinessScore >= undefined` evaluate
 *     `false` for EVERY task, silently filtering out ALL results.
 *
 * Both are now defended in three independent layers: (1) a paired
 * `defaultValue` on the parameter definition (mt#2759), (2) an
 * execute()-level `?? 20` / `?? 0.5` belt-and-suspenders fallback (mt#2759),
 * and (3) this task's shared-layer fix making the Zod-level `.default(...)`
 * itself authoritative at both the MCP and CLI boundaries. This file proves
 * the command-level behavior (layers 1+2) actually holds — there was no
 * prior test exercising it directly.
 */
import { describe, test, expect } from "bun:test";
import { createTasksAvailableCommand } from "./routing-commands";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { AvailableTask, TaskRoutingService } from "@minsky/domain/tasks/task-routing-service";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

function makeFakeAvailableTasks(count: number): AvailableTask[] {
  return Array.from({ length: count }, (_, i) => ({
    taskId: `mt#${i + 1}`,
    title: `Task ${i + 1}`,
    status: "TODO",
    // Cycle through below-threshold / above-threshold readiness scores so
    // the 0.5 default-floor filtering behavior is actually exercised (not
    // masked by every task sharing the same score).
    readinessScore: i % 3 === 0 ? 0.3 : i % 3 === 1 ? 0.6 : 1.0,
    blockedBy: [] as string[],
  }));
}

// The command applies limit-capping and readiness-filtering as two SEPARATE
// steps (findAvailableTasks({ limit }) then a subsequent readinessScore
// filter with its own default). Fully-ready tasks isolate the limit-capping
// assertions below from the (separately tested) readiness-filtering behavior.
function makeFullyReadyTasks(count: number): AvailableTask[] {
  return Array.from({ length: count }, (_, i) => ({
    taskId: `mt#${i + 1}`,
    title: `Task ${i + 1}`,
    status: "TODO",
    readinessScore: 1.0,
    blockedBy: [] as string[],
  }));
}

describe("tasks.available — limit omission (mt#2705 / mt#2759)", () => {
  test("omitting limit returns the documented 20-item cap, not the unbounded list", async () => {
    const allTasks = makeFullyReadyTasks(50);
    const persistenceProvider = { capabilities: { sql: true } } as unknown as PersistenceProvider;
    const routingService = {
      findAvailableTasks: async (opts: { limit?: number }) =>
        // Models the real TaskRoutingService: honors the `limit` it's given.
        allTasks.slice(0, opts.limit),
    } as unknown as TaskRoutingService;
    const taskService = {} as unknown as TaskServiceInterface;

    const command = createTasksAvailableCommand(
      () => persistenceProvider,
      () => routingService,
      () => taskService
    );

    // `limit` genuinely omitted from params — simulates the pre-mt#2759 /
    // pre-mt#2705 bridge behavior where an omitted arg arrived as `undefined`.
    const result = (await command.execute({ json: true } as never)) as {
      data: { count: number };
    };

    expect(result.data.count).toBe(20);
  });

  test("an explicit limit is still honored", async () => {
    const allTasks = makeFullyReadyTasks(50);
    const persistenceProvider = { capabilities: { sql: true } } as unknown as PersistenceProvider;
    const routingService = {
      findAvailableTasks: async (opts: { limit?: number }) => allTasks.slice(0, opts.limit),
    } as unknown as TaskRoutingService;
    const taskService = {} as unknown as TaskServiceInterface;

    const command = createTasksAvailableCommand(
      () => persistenceProvider,
      () => routingService,
      () => taskService
    );

    const result = (await command.execute({ json: true, limit: 5 } as never)) as {
      data: { count: number };
    };

    expect(result.data.count).toBe(5);
  });
});

describe("tasks.available — minReadiness omission (mt#2705 / mt#2759)", () => {
  test("omitting minReadiness does NOT filter out all tasks (regression: previously returned 0)", async () => {
    const allTasks = makeFakeAvailableTasks(9); // 3x 0.3, 3x 0.6, 3x 1.0
    const persistenceProvider = { capabilities: { sql: true } } as unknown as PersistenceProvider;
    const routingService = {
      findAvailableTasks: async (opts: { limit?: number }) =>
        allTasks.slice(0, opts.limit ?? allTasks.length),
    } as unknown as TaskRoutingService;
    const taskService = {} as unknown as TaskServiceInterface;

    const command = createTasksAvailableCommand(
      () => persistenceProvider,
      () => routingService,
      () => taskService
    );

    const result = (await command.execute({ json: true, limit: 20 } as never)) as {
      data: { count: number; availableTasks: Array<{ readinessScore: number }> };
    };

    // Pre-mt#2759 regression shape: `undefined >= undefined` is `false`, so
    // EVERY task would have been filtered out (count === 0). Assert it is
    // neither 0 nor the full 9 — the default (0.5) floor must actually apply.
    expect(result.data.count).toBeGreaterThan(0);
    expect(result.data.count).toBe(6); // the 3x 0.6 + 3x 1.0 tasks
    expect(result.data.availableTasks.every((t) => t.readinessScore >= 0.5)).toBe(true);
  });

  test("an explicit minReadiness is still honored", async () => {
    const allTasks = makeFakeAvailableTasks(9);
    const persistenceProvider = { capabilities: { sql: true } } as unknown as PersistenceProvider;
    const routingService = {
      findAvailableTasks: async (opts: { limit?: number }) =>
        allTasks.slice(0, opts.limit ?? allTasks.length),
    } as unknown as TaskRoutingService;
    const taskService = {} as unknown as TaskServiceInterface;

    const command = createTasksAvailableCommand(
      () => persistenceProvider,
      () => routingService,
      () => taskService
    );

    const result = (await command.execute({
      json: true,
      limit: 20,
      minReadiness: 0.9,
    } as never)) as {
      data: { count: number };
    };

    expect(result.data.count).toBe(3); // only the 3x 1.0 tasks clear a 0.9 floor
  });
});
