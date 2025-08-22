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

  describe("Multi-Backend TaskService - TODO: implement createMultiBackendTaskService", () => {
    describe("Backend Registration", () => {
      it("TODO: should register multiple backends", () => {
        // TODO: Implement createMultiBackendTaskService for multi-backend support
        expect(() => createMultiBackendTaskService()).toThrow("TODO: Multi-backend service not yet implemented");
      });
    });

    describe("Task Operations", () => {
      it("TODO: should support task creation across backends", () => {
        // TODO: Implement createMultiBackendTaskService for multi-backend support
        expect(() => createMultiBackendTaskService()).toThrow("TODO: Multi-backend service not yet implemented");
      });

      it("TODO: should support task listing from all backends", () => {
        // TODO: Implement createMultiBackendTaskService for multi-backend support
        expect(() => createMultiBackendTaskService()).toThrow("TODO: Multi-backend service not yet implemented");
      });
    });

    describe("ID Management", () => {
      it("TODO: should convert all task IDs to qualified format", () => {
        // TODO: Implement createMultiBackendTaskService for multi-backend support
        expect(() => createMultiBackendTaskService()).toThrow("TODO: Multi-backend service not yet implemented");
      });
    });  });
});
