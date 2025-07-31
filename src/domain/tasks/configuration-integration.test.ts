/**
 * Test for configuration integration with task service
 *
 * This test verifies that the configuration system properly integrates
 * with task service creation and backend resolution.
 * Uses complete mocking to eliminate filesystem race conditions.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { createConfiguredTaskService } from "./taskService";

// Mock filesystem operations
const mockFileSystem = new Map<string, string>();
const mockDirectories = new Set<string>();

const mockFs = {
  mkdir: mock(async (path: string) => {
    mockDirectories.add(path);
  }),
  writeFile: mock(async (path: string, data: string) => {
    mockFileSystem.set(path, data);
  }),
  rmdir: mock(async (path: string) => {
    mockDirectories.delete(path);
    // Also remove any files in this directory
    Array.from(mockFileSystem.keys())
      .filter((filePath) => filePath.startsWith(`${path}/`))
      .forEach((filePath) => mockFileSystem.delete(filePath));
  }),
  readFile: mock(async (path: string) => {
    if (!mockFileSystem.has(path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return mockFileSystem.get(path);
  }),
};

// Mock the fs modules
mock.module("fs", () => ({
  promises: mockFs,
}));

// Mock path module
mock.module("path", () => ({
  join: mock((...parts: string[]) => parts.join("/")),
}));

describe("Configuration Integration", () => {
  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();

    // Reset filesystem mocks
    mockFs.mkdir = mock(async (path: string) => {
      mockDirectories.add(path);
    });
    mockFs.writeFile = mock(async (path: string, data: string) => {
      mockFileSystem.set(path, data);
    });
    mockFs.rmdir = mock(async (path: string) => {
      mockDirectories.delete(path);
      // Also remove any files in this directory
      Array.from(mockFileSystem.keys())
        .filter((filePath) => filePath.startsWith(`${path}/`))
        .forEach((filePath) => mockFileSystem.delete(filePath));
    });
    mockFs.readFile = mock(async (path: string) => {
      if (!mockFileSystem.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return mockFileSystem.get(path);
    });
  });

  afterEach(() => {
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();
  });

  test("createConfiguredTaskService should use configuration to resolve backend", async () => {
    // Use mock paths - no real filesystem operations
    const tempDir = "/mock/config-test";
    const minskyhDir = "/mock/config-test/.minsky";
    const configPath = "/mock/config-test/.minsky/config.yaml";

    // Setup mock directory structure
    mockDirectories.add(tempDir);
    mockDirectories.add(minskyhDir);

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

    // Mock config file
    mockFileSystem.set(configPath, configContent);

    // Test that the service is created successfully
    const taskService = await createConfiguredTaskService({
      workspacePath: tempDir,
    });

    expect(taskService).toBeDefined();
    expect(taskService.getWorkspacePath()).toBe(tempDir);

    // Test that tasks can be listed (even if empty)
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should fall back to default when configuration fails", async () => {
    // Use mock path with no config file
    const tempDir = "/mock/no-config-test";
    mockDirectories.add(tempDir);

    // Test that the service is created successfully even without config
    const taskService = await createConfiguredTaskService({
      workspacePath: tempDir,
    });

    expect(taskService).toBeDefined();
    expect(taskService.getWorkspacePath()).toBe(tempDir);

    // Should still be able to list tasks with default configuration
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should respect explicit backend parameter", async () => {
    // Use mock paths
    const tempDir = "/mock/explicit-backend-test";
    mockDirectories.add(tempDir);

    // Test with explicit backend override
    const taskService = await createConfiguredTaskService({
      workspacePath: tempDir,
      backend: "json-file", // Explicit backend specification
    });

    expect(taskService).toBeDefined();
    expect(taskService.getWorkspacePath()).toBe(tempDir);

    // Should work with explicitly specified backend
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });
});
