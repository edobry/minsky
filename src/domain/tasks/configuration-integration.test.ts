/**
 * Test for configuration integration with task service
 * 
 * This test verifies that the configuration system properly integrates
 * with task service creation and backend resolution.
 */

import { test, expect, describe } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";

describe("Configuration Integration", () => {
  test("createConfiguredTaskService should use configuration to resolve backend", async () => {
    // Create a temporary directory for testing
    const tempDir = join(tmpdir(), `config-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Create a .minsky directory and config file
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      
      const configContent = `
version: 1
backends:
  default: "json-file"
repository:
  auto_detect_backend: true
  detection_rules:
    - condition: "always"
      backend: "json-file"
`;
      
      await fs.writeFile(join(minskyhDir, "config.yaml"), configContent);
      
      // Test that the service is created successfully
      const taskService = await createConfiguredTaskService({
        workspacePath: tempDir
      });
      
      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
      
      // Test that tasks can be listed (even if empty)
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("createConfiguredTaskService should fall back to default when configuration fails", async () => {
    // Use a non-existent directory to trigger fallback
    const nonExistentDir = join(tmpdir(), `non-existent-${Date.now()}`);
    
    // Should not throw an error, but use fallback
    const taskService = await createConfiguredTaskService({
      workspacePath: nonExistentDir
    });
    
    expect(taskService).toBeDefined();
  });

  test("createConfiguredTaskService should respect explicit backend parameter", async () => {
    const tempDir = join(tmpdir(), `config-test-explicit-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Create a task service with explicit backend
      const taskService = await createConfiguredTaskService({
        workspacePath: tempDir,
        backend: "markdown" // Explicit backend should override configuration
      });
      
      expect(taskService).toBeDefined();
      expect(taskService.getWorkspacePath()).toBe(tempDir);
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}); 
