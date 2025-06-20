/**
 * Zero-Config Experience Demo Test
 * 
 * This test demonstrates the complete zero-config workflow enabled by the
 * configuration system, showing how tasks can be managed without manual
 * backend flags once configuration is in place.
 */

import { test, expect, describe } from "bun:test";
import { listTasksFromParams } from "./taskCommands";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";

describe("Zero-Config Experience", () => {
  test("tasks can be listed without --backend flag when repository is configured", async () => {
    // Create a temporary directory for testing
    const tempDir = join(tmpdir(), `zero-config-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Set up repository configuration
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      
      const repoConfigContent = `
version: 1
backends:
  default: "json-file"
repository:
  auto_detect_backend: true
  detection_rules:
    - condition: "always"
      backend: "json-file"
`;
      
      await fs.writeFile(join(minskyhDir, "config.yaml"), repoConfigContent);
      
      // Create a minimal tasks.json file for the json-file backend
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      
      const tasksData = {
        tasks: [
          {
            id: "#001",
            title: "Test Task",
            description: "A test task to verify zero-config experience",
            status: "TODO",
            specPath: "process/tasks/001-test-task.md"
          }
        ]
      };
      
      await fs.writeFile(join(processDir, "tasks.json"), JSON.stringify(tasksData, null, 2));
      
      // Test: List tasks WITHOUT providing backend parameter
      // This should automatically resolve the backend from configuration
      const tasks = await listTasksFromParams({
        // No backend parameter provided - should auto-resolve from config
        workspace: tempDir,
        all: true
      });
      
      // Verify the task was found
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("#001");
      expect(tasks[0].title).toBe("Test Task");
      expect(tasks[0].status).toBe("TODO");
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("zero-config experience with backend auto-detection", async () => {
    // Create a temporary directory for testing auto-detection
    const tempDir = join(tmpdir(), `auto-detect-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Set up repository configuration with auto-detection
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      
      const repoConfigContent = `
version: 1
backends:
  default: "json-file"
repository:
  auto_detect_backend: true
  detection_rules:
    - condition: "tasks_md_exists"
      backend: "markdown"
    - condition: "always"
      backend: "json-file"
`;
      
      await fs.writeFile(join(minskyhDir, "config.yaml"), repoConfigContent);
      
      // Create process/tasks.md file to trigger markdown backend detection
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      
      const tasksMarkdown = `
# Tasks

- [x] #001: Completed Task
- [ ] #002: Todo Task - This is a test task
- [-] #003: In Progress Task
`;
      
      await fs.writeFile(join(processDir, "tasks.md"), tasksMarkdown);
      
      // Test: List tasks with auto-detection
      // Should detect markdown backend due to tasks.md existence
      const tasks = await listTasksFromParams({
        workspace: tempDir,
        all: true
      });
      
      // Verify tasks were parsed from markdown
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
      
      // Check that we got the expected tasks from markdown
      const taskIds = tasks.map(task => task.id);
      expect(taskIds).toContain("#001");
      expect(taskIds).toContain("#002");
      expect(taskIds).toContain("#003");
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fallback behavior when no configuration is present", async () => {
    // Create a temporary directory without any configuration
    const tempDir = join(tmpdir(), `fallback-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Create minimal json-file backend data (fallback backend)
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      
      const tasksData = {
        tasks: [
          {
            id: "#001",
            title: "Fallback Task",
            description: "Task created with fallback backend",
            status: "TODO",
            specPath: "process/tasks/001-fallback-task.md"
          }
        ]
      };
      
      await fs.writeFile(join(processDir, "tasks.json"), JSON.stringify(tasksData, null, 2));
      
      // Test: List tasks without any configuration
      // Should fallback to json-file backend
      const tasks = await listTasksFromParams({
        workspace: tempDir,
        all: true
      });
      
      // Verify fallback behavior works
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe("#001");
      expect(tasks[0].title).toBe("Fallback Task");
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("explicit backend parameter still overrides configuration", async () => {
    // Create a temporary directory with configuration
    const tempDir = join(tmpdir(), `override-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Set up repository configuration for json-file
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      
      const repoConfigContent = `
version: 1
backends:
  default: "json-file"
`;
      
      await fs.writeFile(join(minskyhDir, "config.yaml"), repoConfigContent);
      
      // Create both markdown and json-file backend data
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      
      // JSON data
      const tasksData = {
        tasks: [
          {
            id: "#001",
            title: "JSON Task",
            status: "TODO"
          }
        ]
      };
      await fs.writeFile(join(processDir, "tasks.json"), JSON.stringify(tasksData, null, 2));
      
      // Markdown data
      const tasksMarkdown = `
# Tasks

- [ ] #002: Markdown Task
`;
      await fs.writeFile(join(processDir, "tasks.md"), tasksMarkdown);
      
      // Test 1: Without explicit backend (should use config → json-file)
      const jsonTasks = await listTasksFromParams({
        workspace: tempDir,
        all: true
      });
      
      expect(jsonTasks.length).toBe(1);
      expect(jsonTasks[0].title).toBe("JSON Task");
      
      // Test 2: With explicit backend override (should use markdown)
      const markdownTasks = await listTasksFromParams({
        workspace: tempDir,
        backend: "markdown", // Explicit override
        all: true
      });
      
      expect(markdownTasks.length).toBe(1);
      expect(markdownTasks[0].id).toBe("#002");
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}); 
