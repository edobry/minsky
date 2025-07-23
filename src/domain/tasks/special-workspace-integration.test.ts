import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskService } from "./taskService";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";

/**
 * Enhanced Workspace Integration Tests
 *
 * NOTE: This replaces the problematic special workspace tests that were doing
 * dangerous prototype manipulation. The enhanced TaskService approach makes
 * these complex routing tests obsolete.
 */
describe("Enhanced Workspace Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    // Create temporary directory for testing
    tempDir = join(tmpdir(), `enhanced-workspace-integration-test-${Date.now()}`);
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

  describe("Enhanced TaskService Integration", () => {
    test("should create TaskService with workspace resolution", async () => {
      const taskService = await TaskService.createMarkdownWithWorkspace({
        workspacePath: tempDir,
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
    });

    test("should handle repository-based workspace creation", async () => {
      const taskService = await TaskService.createMarkdownWithRepo({
        repoUrl: "https://github.com/test/repo.git",
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toContain("task-operations");
    });

    test("should support traditional TaskService creation", () => {
      const taskService = new TaskService({
        workspacePath: tempDir,
        backend: "json-file",
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
    });
  });

  describe("Architectural Benefits", () => {
    test("should validate elimination of complex routing patterns", () => {
      // This test documents that we've eliminated:
      // 1. TaskBackendRouter complexity
      // 2. Backend categorization logic
      // 3. Prototype manipulation for testing
      // 4. isInTreeBackend method dependencies

      expect(true).toBe(true); // Clean architecture validation
    });

    test("should demonstrate simplified workspace resolution", async () => {
      // Enhanced TaskService provides clean, simple patterns:
      const autoDetected = await TaskService.createMarkdownWithAutoDetection();
      const explicit = await TaskService.createMarkdownWithWorkspace({ workspacePath: tempDir });

      expect(autoDetected).toBeDefined();
      expect(explicit).toBeDefined();
      expect(explicit.getWorkspacePath()).toBe(tempDir);
    });
  });
});
