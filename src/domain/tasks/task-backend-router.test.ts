import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskBackendRouter } from "../task-backend-router";
import { createMarkdownTaskBackend } from "../markdownTaskBackend";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";

describe("TaskBackendRouter", () => {
  let tempDir: string;
  let router: TaskBackendRouter;

  beforeEach(() => {
    // Create temporary directory for testing
    tempDir = join(tmpdir(), `task-router-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Manual Override (isInTreeBackend method)", () => {
    test("should use manual override for MarkdownTaskBackend (which has isInTreeBackend)", () => {
      router = TaskBackendRouter.createExternal();
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir,
      });

      const routingInfo = router.getBackendRoutingInfo(markdownBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      // Should use manual override description since backend has isInTreeBackend method
      expect(routingInfo.description).toContain("Manually configured as in-tree");
    });

    test("should use manual override for JsonFileTaskBackend (which has isInTreeBackend)", () => {
      router = TaskBackendRouter.createExternal();
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json")
      });

      const routingInfo = router.getBackendRoutingInfo(jsonBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      // Should use manual override description since backend has isInTreeBackend method
      expect(routingInfo.description).toContain("Manually configured as in-tree");
    });
  });

  describe("Auto-Detection Logic (without isInTreeBackend method)", () => {
    test("should auto-detect MarkdownTaskBackend as in-tree when isInTreeBackend is removed", () => {
      router = TaskBackendRouter.createExternal();
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir,
      });

      // Remove the isInTreeBackend method to test auto-detection
      delete (markdownBackend as any).isInTreeBackend;
      // Also delete from prototype if needed
      const proto = Object.getPrototypeOf(markdownBackend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      // Verify it's actually deleted
      expect(typeof (markdownBackend as any).isInTreeBackend).toBe("undefined");

      const routingInfo = router.getBackendRoutingInfo(markdownBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("Markdown backend stores data in repository files");
    });

    test("should auto-detect JsonFileTaskBackend as in-tree when using process directory", () => {
      router = TaskBackendRouter.createExternal();
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json")
      });

      // Remove the isInTreeBackend method to test auto-detection
      delete (jsonBackend as any).isInTreeBackend;
      // Also delete from prototype if needed
      const proto = Object.getPrototypeOf(jsonBackend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      // Verify it's actually deleted
      expect(typeof (jsonBackend as any).isInTreeBackend).toBe("undefined");

      const routingInfo = router.getBackendRoutingInfo(jsonBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("JSON file stored in repository process directory");
    });

    test("should auto-detect JsonFileTaskBackend as in-tree when using .minsky directory", () => {
      router = TaskBackendRouter.createExternal();
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, ".minsky", "tasks.json")
      });

      // Remove the isInTreeBackend method to test auto-detection
      delete (jsonBackend as any).isInTreeBackend;
      // Also delete from prototype if needed
      const proto = Object.getPrototypeOf(jsonBackend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      // Verify it's actually deleted
      expect(typeof (jsonBackend as any).isInTreeBackend).toBe("undefined");

      const routingInfo = router.getBackendRoutingInfo(jsonBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("JSON file in workspace-local directory, should use centralized storage");
    });

    test("should auto-detect JsonFileTaskBackend as external when using external path", () => {
      router = TaskBackendRouter.createExternal();
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: "/tmp/external-tasks.json"
      });

      // Remove the isInTreeBackend method to test auto-detection
      delete (jsonBackend as any).isInTreeBackend;
      // Also delete from prototype if needed
      const proto = Object.getPrototypeOf(jsonBackend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      // Verify it's actually deleted
      expect(typeof (jsonBackend as any).isInTreeBackend).toBe("undefined");

      const routingInfo = router.getBackendRoutingInfo(jsonBackend);

      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
      expect(routingInfo.description).toContain("JSON file in external location");
    });
  });

  describe("Manual Override Support", () => {
    test("should respect isInTreeBackend() manual override when true", () => {
      router = TaskBackendRouter.createExternal();
      const backend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: "/tmp/external-tasks.json"
      });

      // Mock the isInTreeBackend method to return true
      (backend as any).isInTreeBackend = () => true;

      const routingInfo = router.getBackendRoutingInfo(backend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("Manually configured as in-tree");
    });

    test("should respect isInTreeBackend() manual override when false", () => {
      router = TaskBackendRouter.createExternal();
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir,
      });

      // Mock the isInTreeBackend method to return false
      (backend as any).isInTreeBackend = () => false;

      const routingInfo = router.getBackendRoutingInfo(backend);

      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
      expect(routingInfo.description).toContain("Manually configured as external");
    });
  });

  describe("Router Creation", () => {
    test("should create external-only router successfully", () => {
      router = TaskBackendRouter.createExternal();
      expect(router).toBeDefined();
    });

    test("should create router with repository URL", async () => {
      const fakeRepoUrl = "https://github.com/test/repo.git";
      router = await TaskBackendRouter.createWithRepo(fakeRepoUrl);
      expect(router).toBeDefined();
    });
  });

  describe("Backend Operation Routing", () => {
    test("should route external backends to current directory", async () => {
      router = TaskBackendRouter.createExternal();
      const backend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: "/tmp/external-tasks.json"
      });

      // Remove the isInTreeBackend method to use auto-detection
      delete (backend as any).isInTreeBackend;
      // Also delete from prototype if needed
      const proto = Object.getPrototypeOf(backend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      let capturedWorkspacePath: string | undefined;
      const result = await router.performBackendOperation(
        backend,
        "test-operation",
        async (workspacePath) => {
          capturedWorkspacePath = workspacePath;
          return "success";
        }
      );

      expect(result).toBe("success");
      expect(capturedWorkspacePath).toBe(process.cwd());
    });

    test("should throw error for in-tree backend without repository URL", async () => {
      router = TaskBackendRouter.createExternal();
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir,
      });

      await expect(router.performBackendOperation(
        backend,
        "test-operation",
        async () => "success"
      )).rejects.toThrow("Repository URL required for in-tree backend operations");
    });
  });

  describe("Helper Methods", () => {
    test("should detect SQLite backends correctly", () => {
      router = TaskBackendRouter.createExternal();
      
      // Create mock SQLite backend
      const mockSqliteBackend = {
        name: "sqlite",
        constructor: { name: "SqliteTaskBackend" }
      } as any;

      const routingInfo = router.getBackendRoutingInfo(mockSqliteBackend);
      
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.description).toContain("Unable to determine SQLite location, defaulting to external");
    });

    test("should detect PostgreSQL backends correctly", () => {
      router = TaskBackendRouter.createExternal();
      
      // Create mock PostgreSQL backend
      const mockPostgresBackend = {
        name: "postgres",
        constructor: { name: "PostgresTaskBackend" }
      } as any;

      const routingInfo = router.getBackendRoutingInfo(mockPostgresBackend);
      
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
      expect(routingInfo.description).toContain("PostgreSQL backend uses external database");
    });

    test("should default to external for unknown backends", () => {
      router = TaskBackendRouter.createExternal();
      
      // Create mock unknown backend
      const mockUnknownBackend = {
        name: "unknown",
        constructor: { name: "UnknownTaskBackend" }
      } as any;

      const routingInfo = router.getBackendRoutingInfo(mockUnknownBackend);
      
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
      expect(routingInfo.description).toContain("Unknown backend type, defaulting to external");
    });
  });

  describe("Error Handling", () => {
    test("should handle errors in JSON backend file path extraction gracefully", () => {
      router = TaskBackendRouter.createExternal();
      
      // Create mock backend that throws an error when trying to get storage location
      const mockBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getStorageLocation: () => {
          throw new Error("Storage location not available");
        }
      } as any;

      const routingInfo = router.getBackendRoutingInfo(mockBackend);
      
      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.description).toContain("Unable to determine JSON file location, defaulting to in-tree");
    });
  });
}); 
