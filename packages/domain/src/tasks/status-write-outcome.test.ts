import { describe, it, expect } from "bun:test";
import { setTaskStatusFromParams } from "./commands/mutation-commands";
import { createTaskService } from "./multi-backend-service";
import type { Task, TaskBackend, BackendCapabilities, StatusWriteOutcome } from "./types";
import type { TaskServiceInterface } from "./taskService";

/**
 * mt#4457 — a status write must not report success unless it actually persisted,
 * and a status READ must not turn a failure into a plausible value.
 *
 * Originating incident (2026-08-23): `tasks_status_set mt#1584 PLANNING -> READY`
 * returned `{success: true, changed: true}` for an UPDATE that never reached the
 * database. The row's `updated_at` predated the "successful" transition. It
 * recurred the same day on mt#4451 and mt#4468.
 *
 * Two independent defects made that possible, and both are covered here:
 *   - the backend discarded the update result and declared `Promise<void>`, so a
 *     zero-row UPDATE (which Postgres raises nothing for) was indistinguishable
 *     from a successful one;
 *   - the adapter's `changed` field was the literal `true`.
 */

const PLANNING_TASK: Task = {
  id: "mt#1",
  title: "A task in PLANNING",
  status: "PLANNING",
};

/**
 * A task service whose write reports a caller-chosen outcome.
 *
 * Hand-built rather than spied-on: the thing under test is precisely what the
 * caller does with the RETURNED outcome, so the outcome has to be an injected
 * value. A `spyOn` here would patch a collaborator the code reaches itself and
 * tell us nothing about the contract (`testing-standards.mdc §Testable Design`).
 */
function serviceReportingOutcome(outcome: StatusWriteOutcome): {
  service: TaskServiceInterface;
  writes: Array<{ id: string; status: string }>;
} {
  const writes: Array<{ id: string; status: string }> = [];
  const service = {
    getTask: async () => PLANNING_TASK,
    getTaskStatus: async () => PLANNING_TASK.status,
    setTaskStatus: async (id: string, status: string) => {
      writes.push({ id, status });
      return outcome;
    },
  } as unknown as TaskServiceInterface;
  return { service, writes };
}

function serviceWhoseWriteThrows(error: Error): TaskServiceInterface {
  return {
    getTask: async () => PLANNING_TASK,
    getTaskStatus: async () => PLANNING_TASK.status,
    setTaskStatus: async () => {
      throw error;
    },
  } as unknown as TaskServiceInterface;
}

describe("mt#4457 AT2 — a write that did not persist cannot report success", () => {
  it("rejects when the update matched zero records", async () => {
    const { service, writes } = serviceReportingOutcome({ recordsAffected: 0 });

    const attempt = setTaskStatusFromParams(
      { taskId: "mt#1", status: "READY" },
      { taskService: service }
    );

    await expect(attempt).rejects.toThrow(/did not persist/);
    // The write WAS attempted — this is a failed write, not a skipped one.
    expect(writes).toEqual([{ id: "mt#1", status: "READY" }]);
  });

  it("names the intended transition and says the status is unchanged", async () => {
    const { service } = serviceReportingOutcome({ recordsAffected: 0 });

    const attempt = setTaskStatusFromParams(
      { taskId: "mt#1", status: "READY" },
      { taskService: service }
    );

    await expect(attempt).rejects.toThrow(/PLANNING -> READY/);
    await expect(attempt).rejects.toThrow(/status is unchanged/);
  });

  it("CONTROL: a write that affected one record resolves and reports it", async () => {
    const { service, writes } = serviceReportingOutcome({ recordsAffected: 1 });

    const outcome = await setTaskStatusFromParams(
      { taskId: "mt#1", status: "READY" },
      { taskService: service }
    );

    expect(outcome).toEqual({ recordsAffected: 1 });
    expect(writes).toEqual([{ id: "mt#1", status: "READY" }]);
  });
});

describe("mt#4457 AT1 — a contended write surfaces as an error, not a success", () => {
  it("propagates the backend's own failure rather than absorbing it", async () => {
    // Shaped after the real observation: PostgreSQL 57014 (`query_canceled`),
    // which is what the incident's CLI reproduction returned on its own
    // connection while the MCP path was reporting success.
    const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });

    const attempt = setTaskStatusFromParams(
      { taskId: "mt#1", status: "READY" },
      { taskService: serviceWhoseWriteThrows(cancelled) }
    );

    await expect(attempt).rejects.toThrow(/statement timeout/);
  });
});

// ---------------------------------------------------------------------------
// Read path (AT3, AT5)
// ---------------------------------------------------------------------------

function backendWith(overrides: Partial<TaskBackend>): TaskBackend {
  const capabilities: BackendCapabilities = {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canList: true,
  };
  return {
    name: "probe",
    prefix: "pb",
    listTasks: async () => [],
    getTask: async () => null,
    getTaskStatus: async () => undefined,
    setTaskStatus: async () => ({ recordsAffected: 1 }),
    createTaskFromTitleAndSpec: async () => {
      throw new Error("not used");
    },
    deleteTask: async () => false,
    getWorkspacePath: () => "/test/workspace",
    getCapabilities: () => capabilities,
    ...overrides,
  } as TaskBackend;
}

function serviceOver(backend: TaskBackend) {
  const service = createTaskService({ workspacePath: "/test/workspace" });
  service.registerBackend(backend);
  return service;
}

describe("mt#4457 AT5 — a failed read is an error, not a value", () => {
  it("surfaces a read failure instead of degrading to the list-scan fallback", async () => {
    let listScanned = false;
    const backend = backendWith({
      getTaskStatus: async () => {
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      },
      // If the fallback is reached, this would answer with a plausible status —
      // exactly the silent degradation this test exists to prevent.
      listTasks: async () => {
        listScanned = true;
        return [{ id: "pb#1", title: "t", status: "DONE" }] as Task[];
      },
    });

    await expect(serviceOver(backend).getTaskStatus("pb#1")).rejects.toThrow(/statement timeout/);
    expect(listScanned).toBe(false);
  });

  it("CONTROL: a healthy read returns its value and never reaches the fallback", async () => {
    let listScanned = false;
    const backend = backendWith({
      getTaskStatus: async () => "PLANNING",
      listTasks: async () => {
        listScanned = true;
        return [];
      },
    });

    expect(await serviceOver(backend).getTaskStatus("pb#1")).toBe("PLANNING");
    expect(listScanned).toBe(false);
  });

  it("still tolerates a backend that does not implement getTaskStatus", async () => {
    // The capability check replaced a bare catch. The tolerance it was actually
    // buying has to survive, or this is a regression rather than a fix.
    const backend = backendWith({
      listTasks: async () => [{ id: "pb#1", title: "t", status: "READY" }] as Task[],
    });
    delete (backend as { getTaskStatus?: unknown }).getTaskStatus;

    expect(await serviceOver(backend).getTaskStatus("pb#1")).toBe("READY");
  });
});

describe("mt#4457 AT3 — read-after-write is consistent", () => {
  it("returns the same value on two consecutive reads after a write", async () => {
    const store = new Map<string, Task>([["pb#1", { id: "pb#1", title: "t", status: "PLANNING" }]]);
    const backend = backendWith({
      getTask: async (id: string) => store.get(id) ?? null,
      getTaskStatus: async (id: string) => store.get(id)?.status,
      setTaskStatus: async (id: string, status: string) => {
        const existing = store.get(id);
        if (!existing) return { recordsAffected: 0 };
        store.set(id, { ...existing, status });
        return { recordsAffected: 1 };
      },
    });
    const service = serviceOver(backend);

    const outcome = await service.setTaskStatus("pb#1", "READY");
    expect(outcome).toEqual({ recordsAffected: 1 });

    expect(await service.getTaskStatus("pb#1")).toBe("READY");
    expect(await service.getTaskStatus("pb#1")).toBe("READY");
  });

  it("reports zero records for a write against a task the backend does not hold", async () => {
    const backend = backendWith({
      setTaskStatus: async () => ({ recordsAffected: 0 }),
    });

    expect(await serviceOver(backend).setTaskStatus("pb#404", "READY")).toEqual({
      recordsAffected: 0,
    });
  });
});
