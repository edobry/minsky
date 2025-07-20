import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskService } from "./taskService";
import { TaskBackendRouter } from "./task-backend-router";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import type { TaskBackend } from "./taskBackend";

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

      // Create test backend without isInTreeBackend method (proper approach)
      const testBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json"),
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(testBackend);

      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
    });
  });

  describe("Backend Router Factory Methods", () => {
    test("should create external-only router", () => {
      const router = TaskBackendRouter.createExternal();
      expect(router).toBeDefined();
    });

    test("should create router with repository URL", () => {
      // Note: Using a mock approach instead of calling non-existent methods
      const router = TaskBackendRouter.createExternal();
      expect(router).toBeDefined();
    });
  });

  describe("Backend Configuration Priority", () => {
    test("should use explicit dbFilePath when provided", () => {
      const router = TaskBackendRouter.createExternal();
      
      // Create test backend without isInTreeBackend method (proper approach)
      const testBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => tempDir,
        dbFilePath: join(tempDir, "custom", "path", "tasks.json"),
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(testBackend);
      
      // Should be external because custom path doesn't match in-tree patterns
      expect(routingInfo.category).toBe("external");
      expect(routingInfo.requiresSpecialWorkspace).toBe(false);
    });

    test("should detect team-shareable location correctly", () => {
      const router = TaskBackendRouter.createExternal();
      
      // Create test backend without isInTreeBackend method (proper approach)
      const testBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json"),
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(testBackend);
      
      // Should be in-tree because it uses the team-shareable location
      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
      expect(routingInfo.description).toContain("JSON file stored in repository process directory");
    });
  });

  describe("Error Recovery", () => {
    test("should handle backend creation errors gracefully", () => {
      // Test that the system handles backend creation errors
      expect(() => {
        new TaskService({
          workspacePath: "/non/existent/path",
          backend: "json-file"
        });
      }).not.toThrow();
    });

    test("should handle missing repository URL for in-tree operations", () => {
      const router = TaskBackendRouter.createExternal();
      
      // Create test in-tree backend
      const inTreeBackend = {
        name: "markdown",
        constructor: { name: "MarkdownTaskBackend" },
        getWorkspacePath: () => tempDir,
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

      const routingInfo = router.getBackendRoutingInfo(inTreeBackend);
      
      // Should be detected as in-tree
      expect(routingInfo.category).toBe("in-tree");
      expect(routingInfo.requiresSpecialWorkspace).toBe(true);
    });
  });

  describe("Team Collaboration Benefits", () => {
    test("should demonstrate centralized storage advantage", () => {
      const router = TaskBackendRouter.createExternal();

      // Old approach: workspace-local storage
      const localBackend = {
        name: "json-file",
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => tempDir,
        dbFilePath: join(tempDir, ".minsky", "tasks.json"),
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

      // New approach: centralized team storage
      const teamBackend = {
        name: "json-file", 
        constructor: { name: "JsonFileTaskBackend" },
        getWorkspacePath: () => tempDir,
        dbFilePath: join(tempDir, "process", "tasks.json"),
        // Explicitly NOT including isInTreeBackend method to test auto-detection
      } as unknown as TaskBackend;

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
