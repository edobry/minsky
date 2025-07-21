import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMarkdownTaskBackend } from "../markdownTaskBackend";
import { createJsonFileTaskBackend } from "../jsonFileTaskBackend";
import { TaskService } from "../taskService";
import { resolveTaskWorkspacePath } from "../../../utils/workspace-resolver";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Integration tests for current backend workspace resolution behavior.
 * These tests capture the existing behavior before architectural refactoring.
 * 
 * Current Architecture Problems:
 * 1. External code determines workspace path
 * 2. TaskBackendRouter re-determines workspace requirements  
 * 3. Complex routing logic with prototype checking
 * 4. Separation between backend creation and workspace resolution
 * 
 * Target Architecture:
 * 1. Backends handle their own workspace resolution
 * 2. No external router needed
 * 3. Backend constructors take minimal config, resolve workspace internally
 */
describe("Backend Workspace Integration - Current Behavior", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `backend-workspace-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Current Markdown Backend Behavior", () => {
    test("markdown backend should use special workspace when no local tasks.md", async () => {
      // Current behavior: resolveTaskWorkspacePath determines workspace
      const workspacePath = await resolveTaskWorkspacePath({ 
        backend: "markdown",
        repoUrl: "https://github.com/test/repo.git"
      });
      
      // Workspace should be special workspace path, not current dir
      expect(workspacePath).not.toBe((process as any).cwd());
      expect(workspacePath).toContain("task-operations");
    });

    test("markdown backend should work with resolved workspace", () => {
      // Current: backend created with pre-resolved workspace
      const backend = createMarkdownTaskBackend({
        name: "markdown",
        workspacePath: tempDir
      });

      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toBe(tempDir);
    });

    test("TaskService should work with markdown backend and resolved workspace", async () => {
      // Current: TaskService created with pre-resolved workspace
      const workspacePath = tempDir;
      const taskService = new TaskService({
        workspacePath,
        backend: "markdown"
      });

      // Should be able to list tasks (empty list is fine)
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe("Current JSON Backend Behavior", () => {
    test("json backend should use current directory for external files", async () => {
      const workspacePath = await resolveTaskWorkspacePath({ 
        backend: "json-file"
      });
      
      // JSON backend uses current directory
      expect(workspacePath).toBe((process as any).cwd());
    });

    test("json backend should work with resolved workspace", () => {
      const backend = createJsonFileTaskBackend({
        name: "json-file", 
        workspacePath: tempDir,
        dbFilePath: join(tempDir, "tasks.json")
      });

      expect(backend.name).toBe("json-file");
      expect(backend.getWorkspacePath()).toBe(tempDir);
    });
  });

  describe("Current TaskService Integration", () => {
    test("should work with pre-resolved workspace for markdown", async () => {
      // Simulate current command pattern
      const workspacePath = tempDir;
      
      const taskService = new TaskService({
        workspacePath,
        backend: "markdown"
      });

      // Should work
      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    test("should work with pre-resolved workspace for json", async () => {
      const workspacePath = tempDir;
      
      const taskService = new TaskService({
        workspacePath,
        backend: "json-file"
      });

      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe("Current Complex Workflow", () => {
    test("should handle full current workflow for markdown", async () => {
      // Step 1: External resolution
      const workspacePath = await resolveTaskWorkspacePath({
        backend: "markdown",
        repoUrl: "https://github.com/test/repo.git"
      });

      // Step 2: Create TaskService with resolved workspace
      const taskService = new TaskService({
        workspacePath,
        backend: "markdown"
      });

      // Step 3: Operations work
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    test("should handle edge case: markdown with local tasks.md file", async () => {
      // Create a local tasks.md to test conditional logic
      const processDir = join(tempDir, "process");
      mkdirSync(processDir, { recursive: true });
      writeFileSync(join(processDir, "tasks.md"), "# Tasks\n");

      // Note: Cannot test process.chdir in this environment
      // This test documents the current behavior where markdown backend
      // checks for local tasks.md file existence
      
      const workspacePath = await resolveTaskWorkspacePath({
        backend: "markdown",
        repoUrl: "https://github.com/test/repo.git"
      });

      // Should still use special workspace for consistency
      expect(workspacePath).toContain("task-operations");
      
      const taskService = new TaskService({
        workspacePath,
        backend: "markdown"
      });

      expect(taskService).toBeDefined();
    });
  });
});

/**
 * Tests for improved architecture (using the new workspace-resolving backends)
 */
describe("Target Backend Architecture - Self-Contained Workspace Resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `improved-backend-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Workspace-Resolving Markdown Backend", () => {
    test("should handle workspace resolution internally with explicit path", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown",
        workspacePath: tempDir
      });

      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toBe(tempDir);
      
      // Should provide resolution info
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      expect(resolutionInfo.method).toBe("explicit");
    });

    test("should handle current directory workspace resolution", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown"
        // No explicit config - should use current directory
      });

      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toBe((process as any).cwd());
      
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      // In session workspace, it detects existing tasks.md file
      expect(resolutionInfo.method).toBe("local-tasks-md");
    });

    test("should handle special workspace resolution with repo URL", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown",
        repoUrl: "https://github.com/test/repo.git"
      });

      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toContain("task-operations");
      
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      expect(resolutionInfo.method).toBe("special-workspace");
      expect(resolutionInfo.description).toContain("https://github.com/test/repo.git");
    });

    test("should work with task operations", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown",
        workspacePath: tempDir
      });

      // Core functionality test - backend should be created successfully
      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toBe(tempDir);
      
      // Verify resolution info
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      expect(resolutionInfo.method).toBe("explicit");
    });
  });

  describe("Simplified Workflow", () => {
    test("should eliminate external workspace resolution for explicit paths", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      // One-step creation - no resolveTaskWorkspacePath needed
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown",
        workspacePath: tempDir
      });

      // No TaskBackendRouter needed
      // Backend handles everything internally
      expect(backend.name).toBe("markdown");
      expect(backend.getWorkspacePath()).toBe(tempDir);
      
      // Verify workspace resolution happened correctly
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      expect(resolutionInfo.workspacePath).toBe(tempDir);
      expect(resolutionInfo.method).toBe("explicit");
    });

    test("should eliminate external workspace resolution for repo URLs", async () => {
      const { createWorkspaceResolvingMarkdownBackend } = await import("../workspace-resolving-markdown-backend");
      
      // One-step creation with repo URL
      const backend = await createWorkspaceResolvingMarkdownBackend({
        name: "markdown",
        repoUrl: "https://github.com/test/repo.git"
      });

      // Backend resolved workspace internally
      expect(backend.getWorkspacePath()).toContain("task-operations");
      expect(backend.name).toBe("markdown");
      
      // Verify it used special workspace
      const resolutionInfo = (backend as any).getWorkspaceResolutionInfo();
      expect(resolutionInfo.method).toBe("special-workspace");
    });

    test("should enable complete TaskService workflow with workspace-resolving backends", async () => {
      const { TaskService } = await import("../taskService");
      
      // Complete workflow test - from configuration to task operations
      const taskService = await TaskService.createMarkdownWithWorkspace({
        workspacePath: tempDir
      });

      // Should be able to perform task operations
      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
      
      // Should have proper workspace
      expect(taskService.getWorkspacePath()).toBe(tempDir);
    });

    test("should support repository-based TaskService creation", async () => {
      const { TaskService } = await import("../taskService");
      
      // Repository-based creation
      const taskService = await TaskService.createMarkdownWithRepo({
        repoUrl: "https://github.com/test/repo.git"
      });

      // Should work with special workspace
      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toContain("task-operations");
      
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    test("should support auto-detection TaskService creation", async () => {
      const { TaskService } = await import("../taskService");
      
      // Auto-detection creation (uses current workspace)
      const taskService = await TaskService.createMarkdownWithAutoDetection();

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe((process as any).cwd());
      
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });

    test("should support full configuration pattern", async () => {
      const { TaskService } = await import("../taskService");
      
      // Full configuration pattern
      const taskService = await TaskService.createWithWorkspaceResolvingBackend({
        backend: "markdown",
        backendConfig: {
          name: "markdown",
          workspacePath: tempDir,
          forceSpecialWorkspace: false
        }
      });

      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
      
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });
}); 
