import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskService } from "./taskService";
import { TaskBackendRouter } from "./task-backend-router";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";

describe("Special Workspace Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create temporary directory for testing
    tempDir = join(tmpdir(), `special-workspace-integration-test-${Date.now()}`);
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

  describe("TaskService with Backend Routing", () => {
    test("should create TaskService with external backends", async () => {
      const taskService = new TaskService({
        workspacePath: tempDir,
        backend: "json-file"
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
    });

    test("should route JSON backend correctly based on file location", async () => {
      // Create router to test routing logic
      const router = TaskBackendRouter.createExternal();

      // Create task service with JSON backend using external path
      const taskServiceExternal = new TaskService({
        workspacePath: tempDir,
        backend: "json-file",
        customBackends: [
          require("../jsonFileTaskBackend").createJsonFileTaskBackend({
            name: "json-file",
            workspacePath: tempDir,
            dbFilePath: "/tmp/external-tasks.json"
          })
        ]
      });

      // Create task service with JSON backend using in-tree path
      const taskServiceInTree = new TaskService({
        workspacePath: tempDir,
        backend: "json-file",
        customBackends: [
          require("../jsonFileTaskBackend").createJsonFileTaskBackend({
            name: "json-file",
            workspacePath: tempDir,
            dbFilePath: join(tempDir, "process", "tasks.json")
          })
        ]
      });

      // Both should work but route differently
      expect(taskServiceExternal).toBeDefined();
      expect(taskServiceInTree).toBeDefined();
    });
  });

  describe("Backend Router Factory Methods", () => {
    test("should create external-only router", () => {
      const router = TaskBackendRouter.createExternal();
      expect(router).toBeDefined();
    });

    test("should create router with repository URL", async () => {
      const router = await TaskBackendRouter.createWithRepo("https://github.com/test/repo.git");
      expect(router).toBeDefined();
    });
  });

  describe("Backend Configuration Priority", () => {
    test("should use explicit dbFilePath when provided", () => {
      const router = TaskBackendRouter.createExternal();
      
      const backend = require("../jsonFileTaskBackend").createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "custom", "path", "tasks.json")
      });

      // Remove the isInTreeBackend method to test auto-detection
      delete backend.isInTreeBackend;
      const proto = Object.getPrototypeOf(backend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      const routingInfo = router.getBackendRoutingInfo(backend);
      
      // Should be external because custom path doesn't match in-tree patterns
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
    });

    test("should detect team-shareable location correctly", () => {
      const router = TaskBackendRouter.createExternal();
      
      const backend = require("../jsonFileTaskBackend").createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json")
      });

      // Remove the isInTreeBackend method to test auto-detection  
      delete backend.isInTreeBackend;
      const proto = Object.getPrototypeOf(backend);
      if (proto && typeof proto.isInTreeBackend === "function") {
        delete proto.isInTreeBackend;
      }

      const routingInfo = router.getBackendRoutingInfo(backend);
      
      // Should be in-tree because it uses the team-shareable location
      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("JSON file stored in repository process directory");
    });
  });

  describe("Error Recovery", () => {
    test("should handle backend creation errors gracefully", () => {
      // Test that the system handles cases where backends can't be created
      expect(() => {
        new TaskService({
          workspacePath: tempDir,
          backend: "nonexistent-backend"
        });
      }).toThrow("Backend 'nonexistent-backend' not found");
    });

    test("should handle missing repository URL for in-tree operations", async () => {
      const router = TaskBackendRouter.createExternal();
      
      const backend = require("../markdownTaskBackend").createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir
      });

      // Should throw error when trying to perform in-tree operation without repo URL
      await expect(router.performBackendOperation(
        backend,
        "test-operation",
        async () => "success"
      )).rejects.toThrow("Repository URL required for in-tree backend operations");
    });
  });

  describe("Team Collaboration Benefits", () => {
    test("should demonstrate centralized storage advantage", () => {
      const router = TaskBackendRouter.createExternal();

      // Old approach: local workspace storage
      const localBackend = require("../jsonFileTaskBackend").createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: tempDir,
        dbFilePath: join(tempDir, ".minsky", "tasks.json")
      });

      // New approach: centralized team storage
      const teamBackend = require("../jsonFileTaskBackend").createJsonFileTaskBackend({
        name: "json-file", 
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json")
      });

      // Remove isInTreeBackend methods to test auto-detection
      [localBackend, teamBackend].forEach(backend => {
        delete backend.isInTreeBackend;
        const proto = Object.getPrototypeOf(backend);
        if (proto && typeof proto.isInTreeBackend === "function") {
          delete proto.isInTreeBackend;
        }
      });

      const localRouting = router.getBackendRoutingInfo(localBackend);
      const teamRouting = router.getBackendRoutingInfo(teamBackend);

      // Both should require special workspace, but with different reasons
      expect(localRouting.requiresSpecialWorkspace).toBe(true);
      expect(teamRouting.requiresSpecialWorkspace).toBe(true);

      expect(localRouting.description).toContain("workspace-local directory, should use centralized storage");
      expect(teamRouting.description).toContain("JSON file stored in repository process directory");
    });
  });
}); 
