import { describe, it, expect } from "bun:test";

import {
  createMockBackend,
  createTaskServiceWithMocks,
  mockTaskSpecs,
} from "./mock-backend-factory";

describe("Multi-Backend Task System", () => {
  describe("TaskBackend Interface", () => {
    it("should include prefix property for qualified IDs", () => {
      const mockBackend = createMockBackend("Markdown", "md");

      expect(mockBackend.name).toBe("Markdown");
      expect(mockBackend.prefix).toBe("md");
      expect(typeof mockBackend.exportTask).toBe("function");
      expect(typeof mockBackend.importTask).toBe("function");
      expect(typeof mockBackend.validateLocalId).toBe("function");
    });

    it("should support different backend prefixes", () => {
      const markdownBackend = createMockBackend("Markdown", "md");
      const githubBackend = createMockBackend("GitHub Issues", "gh");

      expect(markdownBackend.prefix).toBe("md");
      expect(githubBackend.prefix).toBe("gh");
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
        const {
          service,
          mdBackend: _mdBackend,
          ghBackend: _ghBackend,
        } = createTaskServiceWithMocks();
        const backends = service.listBackends();
        expect(backends.length).toBe(2);
        expect(backends.map((b) => b.prefix)).toEqual(["md", "gh"]);
      });
    });

    describe("Task Operations", () => {
      it("should support task creation across backends", async () => {
        const { service } = createTaskServiceWithMocks();
        const spec = mockTaskSpecs.simple();

        const created = await service.createTaskFromTitleAndSpec(spec.title, spec.spec);
        expect(created).toBeDefined();
        expect(created.title).toBe(spec.title);
      });

      it("should support task listing from all backends", async () => {
        const { service } = createTaskServiceWithMocks();
        const all = await service.listTasks();
        expect(all.length).toBe(4);
        const ids = all.map((t) => t.id);
        expect(ids).toContain("md#1");
        expect(ids).toContain("gh#1");
      });
    });

    describe("ID Management", () => {
      it("should convert all task IDs to qualified format", async () => {
        const { service } = createTaskServiceWithMocks();
        const all = await service.listTasks();
        expect(all.every((t) => /.+#.+/.test(t.id))).toBe(true);
      });
    });
  });
});
