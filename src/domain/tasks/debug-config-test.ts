/**
 * Debug test to understand configuration integration issues
 */

import { test, expect, describe } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { configurationService } from "../configuration";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";

describe("Debug Configuration Integration", () => {
  test("step-by-step debugging of configuration resolution", async () => {
    // Create a temporary directory for testing
    const tempDir = join(tmpdir(), `debug-config-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      console.log("Debug: Working directory:", tempDir);
      
      // Set up repository configuration
      const minskyhDir = join(tempDir, ".minsky");
      await fs.mkdir(minskyhDir, { recursive: true });
      
      const repoConfigContent = `
version: 1
backends:
  default: "json-file"
`;
      
      await fs.writeFile(join(minskyhDir, "config.yaml"), repoConfigContent);
      console.log("Debug: Created config file");
      
      // Test configuration loading directly
      const configResult = await configurationService.loadConfiguration(tempDir);
      console.log("Debug: Configuration loaded:", JSON.stringify(configResult, null, 2));
      
      // Create a minimal tasks.json file for the json-file backend
      const processDir = join(tempDir, "process");
      await fs.mkdir(processDir, { recursive: true });
      
      const tasksData = {
        tasks: [
          {
            id: "#001",
            title: "Debug Task",
            description: "A debug task",
            status: "TODO",
            specPath: "process/tasks/001-debug-task.md"
          }
        ]
      };
      
      await fs.writeFile(join(processDir, "tasks.json"), JSON.stringify(tasksData, null, 2));
      console.log("Debug: Created tasks.json file");
      
      // Test task service creation with configuration
      const taskService = await createConfiguredTaskService({
        workspacePath: tempDir
      });
      
      console.log("Debug: Task service created, workspace path:", taskService.getWorkspacePath());
      
      // Test listing tasks directly from task service
      const tasks = await taskService.listTasks();
      console.log("Debug: Tasks found:", tasks.length, tasks);
      
      expect(tasks.length).toBeGreaterThan(0);
      
    } finally {
      // Cleanup
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("test configuration resolution without task service", async () => {
    const tempDir = join(tmpdir(), `config-only-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    try {
      // Create config
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
      
      // Test configuration loading
      const configResult = await configurationService.loadConfiguration(tempDir);
      
      console.log("Config sources:", configResult.sources);
      console.log("Resolved config:", configResult.resolved);
      
      expect(configResult.resolved.backend).toBe("json-file");
      
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}); 
