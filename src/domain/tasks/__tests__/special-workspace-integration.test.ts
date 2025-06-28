import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { rmSync, existsSync, mkdirSync } from "fs";
import { TaskBackendRouter, isInTreeBackendCapable } from "../task-backend-router";
import { SpecialWorkspaceManager } from "../../workspace/special-workspace-manager";
import { createMarkdownTaskBackend } from "../markdownTaskBackend";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import { TaskService } from "../taskService";

describe("Special Workspace Integration", () => {
  const testRepoUrl = "https://github.com/test/test-repo.git";
  const testBaseDir = join(process.cwd(), "test-tmp", "special-workspace-test");
  
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
    mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  describe("Backend Type Detection", () => {
    it("should correctly identify in-tree backends", () => {
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: "/test/path"
      });

      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file", 
        workspacePath: "/test/path"
      });

      // Test interface capability detection
      expect(isInTreeBackendCapable(markdownBackend)).toBe(true);
      expect(isInTreeBackendCapable(jsonBackend)).toBe(true);

      // Test actual method calls using type guards
      if (isInTreeBackendCapable(markdownBackend)) {
        expect(markdownBackend.isInTreeBackend()).toBe(true);
      }
      if (isInTreeBackendCapable(jsonBackend)) {
        expect(jsonBackend.isInTreeBackend()).toBe(true);
      }
    });
  });

  describe("TaskBackendRouter", () => {
    it("should route in-tree backends correctly", () => {
      const router = TaskBackendRouter.externalOnly();
      
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: "/test/path"
      });

      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: "/test/path" 
      });

      // In-tree backends should always require special workspace when they declare isInTreeBackend() = true
      // The router will attempt to route them, but without a special workspace manager, 
      // getWorkspacePath() will fall back to normal resolution
      expect(router.requiresSpecialWorkspace(markdownBackend)).toBe(true);
      expect(router.requiresSpecialWorkspace(jsonBackend)).toBe(true);
    });

    it("should create router with different strategies", () => {
      const externalRouter = TaskBackendRouter.externalOnly();
      expect(externalRouter).toBeDefined();

      // Note: withSpecialWorkspace requires actual git repo, so we test the factory method only
      expect(TaskBackendRouter.withSpecialWorkspace).toBeDefined();
    });
  });

  describe("TaskService Integration", () => {
    it("should create TaskService with default backends", () => {
      const taskService = new TaskService({
        workspacePath: testBaseDir,
        backend: "markdown"
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(testBaseDir);
    });

    it("should support custom backends", () => {
      const customBackend = createJsonFileTaskBackend({
        name: "json-file", // Use consistent name
        workspacePath: testBaseDir,
        dbFilePath: join(testBaseDir, "custom-tasks.json")
      });

      const taskService = new TaskService({
        workspacePath: testBaseDir,
        backend: "json-file", // Match the backend name
        customBackends: [customBackend]
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(testBaseDir);
    });
  });

  describe("JSON Backend Storage Location", () => {
    it("should use provided dbFilePath when specified", () => {
      const customDbPath = join(testBaseDir, "process", "tasks.json");
      
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: customDbPath
      }) as any; // Cast to access extended methods

      expect(jsonBackend.getStorageLocation()).toBe(customDbPath);
    });

    it("should default to process/tasks.json location", () => {
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file", 
        workspacePath: testBaseDir
      }) as any; // Cast to access extended methods

      const expectedPath = join(testBaseDir, "process", "tasks.json");
      expect(jsonBackend.getStorageLocation()).toBe(expectedPath);
    });

    it("should be identified as in-tree backend", () => {
      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir
      });

      if (isInTreeBackendCapable(jsonBackend)) {
        expect(jsonBackend.isInTreeBackend()).toBe(true);
      }
    });
  });

  describe("Architecture Integration", () => {
    it("should demonstrate the complete workflow", async () => {
      // 1. Create backends that support the new architecture
      const markdownBackend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: testBaseDir
      });

      const jsonBackend = createJsonFileTaskBackend({
        name: "json-file",
        workspacePath: testBaseDir,
        dbFilePath: join(testBaseDir, "process", "tasks.json")
      });

      // 2. Verify in-tree detection works using type guards
      if (isInTreeBackendCapable(markdownBackend)) {
        expect(markdownBackend.isInTreeBackend()).toBe(true);
      }
      if (isInTreeBackendCapable(jsonBackend)) {
        expect(jsonBackend.isInTreeBackend()).toBe(true);
      }

      // 3. Create router (external-only for testing)
      const router = TaskBackendRouter.externalOnly();

      // 4. Get workspace paths for backends 
      const markdownPath = await router.getWorkspacePathForBackend(markdownBackend);
      const jsonPath = await router.getWorkspacePathForBackend(jsonBackend);

      // External router should use normal workspace resolution
      expect(markdownPath).toBeDefined();
      expect(jsonPath).toBeDefined();

      // 5. Create TaskService with custom backends
      const taskService = new TaskService({
        workspacePath: testBaseDir,
        backend: "json-file",
        customBackends: [markdownBackend, jsonBackend],
        backendRouter: router
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(testBaseDir);
    });
  });
}); 
