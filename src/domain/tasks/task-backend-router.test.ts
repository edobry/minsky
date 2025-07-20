import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskBackendRouter } from "./task-backend-router";
import { createMarkdownTaskBackend } from "./markdownTaskBackend";
import { createJsonFileTaskBackend } from "./jsonFileTaskBackend";
import { rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TaskBackend } from "./taskBackend";

describe("TaskBackendRouter", () => {
  let router: TaskBackendRouter;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `task-backend-router-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Router Creation", () => {
    test("should create external-only router successfully", () => {
      router = TaskBackendRouter.createExternal();
      expect(router).toBeDefined();
    });

    test("should create router with repository URL", () => {
      router = TaskBackendRouter.createWithRepositoryUrl("https://github.com/test/repo");
      expect(router).toBeDefined();
    });
  });

  describe("Backend Operation Routing", () => {
    test("should route external backends to current directory", () => {
      router = TaskBackendRouter.createExternal();
      const externalBackend = {
        name: "external-test",
        constructor: { name: "ExternalBackend" },
        getWorkspacePath: () => tempDir,
      } as unknown as TaskBackend;

      const workspacePath = router.getWorkspacePathForBackend(externalBackend);
      expect(workspacePath).toBe(tempDir);
    });

    test("should throw error for in-tree backend without repository URL", () => {
      router = TaskBackendRouter.createExternal();
      const inTreeBackend = {
        name: "in-tree-test",
        constructor: { name: "MarkdownTaskBackend" },
        getWorkspacePath: () => tempDir,
      } as unknown as TaskBackend;

      expect(() => {
        router.getWorkspacePathForBackend(inTreeBackend);
      }).toThrow("Cannot route in-tree backend");
    });
  });

  describe("Helper Methods", () => {
    test("should detect SQLite backends correctly", () => {
      const sqliteBackend = {
        name: "sqlite",
        constructor: { name: "SqliteTaskBackend" },
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(sqliteBackend);
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.description).toContain("SQLite database");
    });

    test("should detect PostgreSQL backends correctly", () => {
      const postgresBackend = {
        name: "postgres", 
        constructor: { name: "PostgresTaskBackend" },
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(postgresBackend);
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.description).toContain("PostgreSQL database");
    });

    test("should default to external for unknown backends", () => {
      const unknownBackend = {
        name: "unknown",
        constructor: { name: "UnknownBackend" },
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(unknownBackend);
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.description).toContain("Unknown backend type");
    });
  });

  describe("Error Handling", () => {
    test("should handle errors in JSON backend file path extraction gracefully", async () => {
      const brokenBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => { throw new Error("Test error"); },
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(brokenBackend);
      
      // Should fallback gracefully to in-tree when it can't determine the path
      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
    });
  });
}); 
