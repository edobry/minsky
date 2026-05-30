import { describe, it, expect } from "bun:test";
import type { Task, BackendCapabilities } from "./types";
import type { TaskBackend, TaskService } from "./multi-backend-service";
import { createTaskService } from "./multi-backend-service";

/**
 * Regression tests for mt#2179: process-local `lastKnownStatusById` cache used
 * to short-circuit `getTaskStatus`, returning stale values when:
 *   (a) another `TaskServiceImpl` instance backed by the same store wrote a new
 *       status, OR
 *   (b) within a single instance, `setTaskStatus` was called after the cache
 *       had been seeded by an earlier `updateTask` (`setTaskStatus` never
 *       wrote the cache).
 *
 * Both scenarios are reproduced below. With the cache removed, both must pass.
 */

function createSharedBackend(): { backend: TaskBackend; store: Map<string, Task> } {
  const store = new Map<string, Task>();
  const capabilities: BackendCapabilities = {
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    canList: true,
  };
  const backend: TaskBackend = {
    name: "shared",
    prefix: "sh",
    listTasks: async () => Array.from(store.values()),
    getTask: async (id) => store.get(id) ?? null,
    getTaskStatus: async (id) => store.get(id)?.status,
    setTaskStatus: async (id, status) => {
      const existing = store.get(id);
      if (!existing) {
        store.set(id, { id, title: id, status, metadata: {} });
        return;
      }
      store.set(id, { ...existing, status });
    },
    createTaskFromTitleAndSpec: async (title) => {
      const id = `sh#${store.size + 1}`;
      const task: Task = { id, title, status: "TODO", metadata: {} };
      store.set(id, task);
      return task;
    },
    deleteTask: async (id) => store.delete(id),
    getWorkspacePath: () => "/test/workspace",
    getCapabilities: () => capabilities,
  };
  return { backend, store };
}

function newService(backend: TaskBackend): TaskService {
  const service = createTaskService({ workspacePath: "/test/workspace" });
  service.registerBackend(backend);
  return service;
}

describe("TaskServiceImpl.getTaskStatus — cache-coherence (mt#2179)", () => {
  it("reflects writes made by another instance backed by the same store", async () => {
    const { backend, store } = createSharedBackend();
    store.set("sh#1", { id: "sh#1", title: "t", status: "PLANNING", metadata: {} });

    const instanceA = newService(backend);
    const instanceB = newService(backend);

    // A reads first — would have seeded the legacy cache.
    expect(await instanceA.getTaskStatus("sh#1")).toBe("PLANNING");

    // B writes (e.g., a different process advancing the task to DONE).
    await instanceB.setTaskStatus("sh#1", "DONE");

    // A's next read must reflect B's write.
    expect(await instanceA.getTaskStatus("sh#1")).toBe("DONE");
  });

  it("reflects setTaskStatus within the same instance after updateTask has run", async () => {
    const { backend, store } = createSharedBackend();
    store.set("sh#1", { id: "sh#1", title: "t", status: "TODO", metadata: {} });

    const service = newService(backend);

    // updateTask used to seed the legacy cache.
    await service.updateTask("sh#1", { status: "PLANNING" });
    expect(await service.getTaskStatus("sh#1")).toBe("PLANNING");

    // setTaskStatus never wrote the cache; the next read used to return stale "PLANNING".
    await service.setTaskStatus("sh#1", "DONE");
    expect(await service.getTaskStatus("sh#1")).toBe("DONE");
  });

  it("returns fresh values after a sequence of setTaskStatus calls on a fresh instance", async () => {
    const { backend, store } = createSharedBackend();
    store.set("sh#1", { id: "sh#1", title: "t", status: "TODO", metadata: {} });

    const service = newService(backend);
    await service.setTaskStatus("sh#1", "PLANNING");
    expect(await service.getTaskStatus("sh#1")).toBe("PLANNING");
    await service.setTaskStatus("sh#1", "READY");
    expect(await service.getTaskStatus("sh#1")).toBe("READY");
    await service.setTaskStatus("sh#1", "DONE");
    expect(await service.getTaskStatus("sh#1")).toBe("DONE");
  });

  it("prefers backend.getTaskStatus over backend.getTask (defends against backend-internal caches)", async () => {
    const capabilities: BackendCapabilities = {
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canList: true,
    };
    const split: TaskBackend = {
      name: "split",
      prefix: "sp",
      // getTask returns a STALE status (simulates a backend-internal cache).
      getTask: async (id) => ({ id, title: id, status: "STALE_FROM_GET_TASK", metadata: {} }),
      // getTaskStatus is the dedicated FRESH path.
      getTaskStatus: async () => "FRESH",
      listTasks: async () => [],
      setTaskStatus: async () => {},
      createTaskFromTitleAndSpec: async () => ({
        id: "sp#1",
        title: "x",
        status: "TODO",
        metadata: {},
      }),
      deleteTask: async () => true,
      getWorkspacePath: () => "/test/workspace",
      getCapabilities: () => capabilities,
    };
    const service = newService(split);
    expect(await service.getTaskStatus("sp#1")).toBe("FRESH");
  });

  it("falls back to cross-backend aggregated search when no backend routes the ID", async () => {
    // Service has no backend matching prefix "zz#" — routeToBackend would throw.
    // But a registered backend holds the task under the unqualified id.
    const { backend, store } = createSharedBackend();
    store.set("zz#1", { id: "zz#1", title: "t", status: "READY", metadata: {} });
    const service = newService(backend);
    // routeToBackend throws inside getTaskStatus; the cross-backend
    // `this.getTask("zz#1")` fallback finds the task and returns its status.
    expect(await service.getTaskStatus("zz#1")).toBe("READY");
  });
});
