import { describe, it, expect, mock } from "bun:test";
import type { Task } from "./types";
import type {
  TaskBackend,
  TaskSpec,
  TaskFilters,
  TaskExportData,
  MigrationResult,
  CollisionReport,
  TaskCollision,
  MultiBackendTaskService,
} from "./multi-backend-service";
import { createMockBackend } from "./mock-backend-factory";
import { createMultiBackendTaskService } from "./multi-backend-service";

describe("Multi-Backend Task System", () => {
  describe("TaskBackend Interface", () => {
    it("should include prefix property for qualified IDs", () => {
      const mockBackend = createMockBackend("Markdown", "md");

      expect(mockBackend.name).toBe("Markdown");
      expect(mockBackend.prefix).toBe("md");
      expect(typeof mockBackend.createTask).toBe("function");
      expect(typeof mockBackend.exportTask).toBe("function");
      expect(typeof mockBackend.importTask).toBe("function");
      expect(typeof mockBackend.validateLocalId).toBe("function");
    });

    it("should support different backend prefixes", () => {
      const markdownBackend = createMockBackend("Markdown", "md");
      const githubBackend = createMockBackend("GitHub Issues", "gh");
      const jsonBackend = createMockBackend("JSON File", "json");

      expect(markdownBackend.prefix).toBe("md");
      expect(githubBackend.prefix).toBe("gh");
      expect(jsonBackend.prefix).toBe("json");
    });

    it("should validate local IDs according to backend rules", () => {
      const backend = createMockBackend("test", "test");

      expect(backend.validateLocalId("123")).toBe(true);
      expect(backend.validateLocalId("task-123")).toBe(true);
      expect(backend.validateLocalId("")).toBe(false);
    });
  });

  describe("Multi-Backend TaskService", () => {
    describe("Backend Registration", () => {
      it("should register multiple backends", () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        expect(service.getBackend("md")).toBe(mdBackend);
        expect(service.getBackend("gh")).toBe(ghBackend);
        expect(service.listBackends()).toHaveLength(2);
      });

      it("should prevent duplicate backend prefixes", () => {
        const service = createMultiBackendTaskService();
        const backend1 = createMockBackend("Backend1", "md");
        const backend2 = createMockBackend("Backend2", "md"); // Same prefix

        service.registerBackend(backend1);
        expect(() => service.registerBackend(backend2)).toThrow(
          "Backend with prefix 'md' already registered"
        );
      });

      it("should return null for unknown backends", () => {
        const service = createMultiBackendTaskService();
        expect(service.getBackend("unknown")).toBeNull();
      });
    });

    describe("Task Routing", () => {
      it("should route qualified task IDs to correct backend", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        // Mock the getTask method
        mdBackend.getTask = mock(() => Promise.resolve({ id: "md#123", title: "MD Task" } as Task));
        ghBackend.getTask = mock(() => Promise.resolve({ id: "gh#456", title: "GH Task" } as Task));

        const mdTask = await service.getTask("md#123");
        const ghTask = await service.getTask("gh#456");

        expect(mdTask?.id).toBe("md#123");
        expect(ghTask?.id).toBe("gh#456");
        expect(mdBackend.getTask).toHaveBeenCalledWith("123");
        expect(ghBackend.getTask).toHaveBeenCalledWith("456");
      });

      it("should handle unqualified task IDs with default backend", async () => {
        const service = createMultiBackendTaskService();
        const defaultBackend = createMockBackend("Default", "md");

        service.registerBackend(defaultBackend);
        defaultBackend.getTask = mock(() =>
          Promise.resolve({ id: "123", title: "Unqualified Task" } as Task)
        );

        const task = await service.getTask("123");

        expect(task?.id).toBe("123");
        expect(defaultBackend.getTask).toHaveBeenCalledWith("123");
      });

      it("should throw error for unknown backend in qualified ID", async () => {
        const service = createMultiBackendTaskService();

        await expect(service.getTask("unknown#123")).rejects.toThrow(
          "No backend registered for prefix 'unknown'"
        );
      });
    });

    describe("Cross-Backend Operations", () => {
      it("should list tasks from all backends", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.listTasks = mock(() =>
          Promise.resolve([
            { id: "md#123", title: "MD Task 1" },
            { id: "md#124", title: "MD Task 2" },
          ] as Task[])
        );

        ghBackend.listTasks = mock(() =>
          Promise.resolve([{ id: "gh#456", title: "GH Task 1" }] as Task[])
        );

        const allTasks = await service.listAllTasks();

        expect(allTasks).toHaveLength(3);
        expect(allTasks.map((t) => t.id)).toContain("md#123");
        expect(allTasks.map((t) => t.id)).toContain("gh#456");
      });

      it("should filter tasks by backend", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.listTasks = mock(() =>
          Promise.resolve([{ id: "md#123", title: "MD Task" }] as Task[])
        );

        const mdTasks = await service.listAllTasks({ backend: "md" });

        expect(mdTasks).toHaveLength(1);
        expect(mdTasks[0]!.id).toBe("md#123");
        expect(mdBackend.listTasks).toHaveBeenCalled();
        expect(ghBackend.listTasks).not.toHaveBeenCalled();
      });

      it("should search across multiple backends", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.listTasks = mock(() =>
          Promise.resolve([{ id: "md#123", title: "Search Result MD" }] as Task[])
        );

        ghBackend.listTasks = mock(() =>
          Promise.resolve([{ id: "gh#456", title: "Search Result GH" }] as Task[])
        );

        const results = await service.searchTasks("Search Result");

        expect(results).toHaveLength(2);
        expect(results.map((t) => t.title)).toContain("Search Result MD");
        expect(results.map((t) => t.title)).toContain("Search Result GH");
      });
    });

    describe("Task Migration", () => {
      it("should migrate task between backends", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        const exportData: TaskExportData = {
          spec: { title: "Migrated Task" },
          metadata: {},
          backend: "md",
          exportedAt: new Date().toISOString(),
        };

        mdBackend.exportTask = mock(() => Promise.resolve(exportData));
        ghBackend.importTask = mock(() =>
          Promise.resolve({ id: "gh#789", title: "Migrated Task" } as Task)
        );

        const result = await service.migrateTask("md#123", "gh");

        expect(result.success).toBe(true);
        expect(result.sourceTaskId).toBe("md#123");
        expect(result.targetTaskId).toBe("gh#789");
        expect(mdBackend.exportTask).toHaveBeenCalledWith("123");
        expect(ghBackend.importTask).toHaveBeenCalledWith(exportData);
      });

      it("should handle migration failures gracefully", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.exportTask = mock(() => Promise.reject(new Error("Export failed")));

        const result = await service.migrateTask("md#123", "gh");

        expect(result.success).toBe(false);
        expect(result.errors).toContain("Export failed");
      });
    });

    describe("Collision Detection", () => {
      it("should detect ID collisions between backends", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.listTasks = mock(() =>
          Promise.resolve([{ id: "md#123", title: "MD Task" }] as Task[])
        );

        ghBackend.listTasks = mock(() =>
          Promise.resolve([
            { id: "gh#123", title: "GH Task" }, // Same local ID
          ] as Task[])
        );

        const report = await service.detectCollisions();

        expect(report.total).toBe(1);
        expect(report.collisions).toHaveLength(1);
        expect(report.collisions[0]!.localId).toBe("123");
        expect(report.collisions[0]!.backends).toEqual(["md", "gh"]);
        expect(report.collisions[0]!.type).toBe("id_collision");
      });

      it("should generate collision summary by backend", async () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        mdBackend.listTasks = mock(() =>
          Promise.resolve([
            { id: "md#123", title: "MD Task 1" },
            { id: "md#124", title: "MD Task 2" },
          ] as Task[])
        );

        ghBackend.listTasks = mock(() =>
          Promise.resolve([
            { id: "gh#123", title: "GH Task" }, // Collision with md#123
          ] as Task[])
        );

        const report = await service.detectCollisions();

        expect(report.summary.byBackend.md).toBe(1);
        expect(report.summary.byBackend.gh).toBe(1);
        expect(report.summary.byType.id_collision).toBe(1);
      });
    });

    describe("Backend Selection", () => {
      it("should select default backend for new tasks", () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");

        service.registerBackend(mdBackend);

        const selected = service.selectBackendForNewTask();
        expect(selected).toBe(mdBackend);
      });

      it("should select backend based on configuration", () => {
        const service = createMultiBackendTaskService();
        const mdBackend = createMockBackend("Markdown", "md");
        const ghBackend = createMockBackend("GitHub", "gh");

        service.registerBackend(mdBackend);
        service.registerBackend(ghBackend);

        // Implementation should have logic for selection
        const selected = service.selectBackendForNewTask();
        expect([mdBackend, ghBackend]).toContain(selected);
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle backend failures gracefully", async () => {
      const service = createMultiBackendTaskService();
      const faultyBackend = createMockBackend("Faulty", "faulty");

      service.registerBackend(faultyBackend);
      faultyBackend.getTask = mock(() => Promise.reject(new Error("Backend error")));

      await expect(service.getTask("faulty:123")).rejects.toThrow("Backend error");
    });

    it("should validate qualified ID format", async () => {
      const service = createMultiBackendTaskService();

      await expect(service.getTask("invalid:")).rejects.toThrow();
      await expect(service.getTask(":123")).rejects.toThrow();
      await expect(service.getTask("")).rejects.toThrow();
    });

    it("should handle empty backend list gracefully", async () => {
      const service = createMultiBackendTaskService();

      const tasks = await service.listAllTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("Backward Compatibility", () => {
    it("should handle existing unqualified task operations", async () => {
      const service = createMultiBackendTaskService();
      const defaultBackend = createMockBackend("Default", "md");

      service.registerBackend(defaultBackend);
      defaultBackend.getTask = mock(() =>
        Promise.resolve({ id: "123", title: "Legacy Task" } as Task)
      );

      const task = await service.getTask("123");
      expect(task?.id).toBe("123");
      expect(defaultBackend.getTask).toHaveBeenCalledWith("123");
    });

    it("should maintain existing task ID formats in responses", async () => {
      const service = createMultiBackendTaskService();
      const backend = createMockBackend("Test", "test");

      service.registerBackend(backend);
      backend.listTasks = mock(() =>
        Promise.resolve([
          { id: "123", title: "Legacy Task" }, // Unqualified
          { id: "test:456", title: "New Task" }, // Qualified
        ] as Task[])
      );

      const tasks = await service.listAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.id).toBe("123"); // Unchanged
      expect(tasks[1]!.id).toBe("test:456"); // Unchanged
    });
  });
});
