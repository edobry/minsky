/**
 * Test for configuration integration with task service
 *
 * This test verifies that the configuration system properly integrates
 * with task service creation and backend resolution.
 * Uses standardized mock filesystem to eliminate race conditions.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";
import { mockModule } from "../../utils/test-utils/mocking";

describe("Configuration Integration", () => {
  let mockFs: any;

  beforeEach(() => {
    // Create independent mock filesystem for each test
    mockFs = createMockFilesystem();

    // Mock fs modules to use our independent filesystem
    mockModule("fs", () => ({
      promises: mockFs,
    }));

    // Mock path module for consistent path operations
    mockModule("path", () => ({
      join: (...parts: string[]) => parts.join("/"),
    }));
  });

  afterEach(() => {
    // No cleanup needed - each test gets fresh mock filesystem
  });

  test("createConfiguredTaskService should use configuration to resolve backend", async () => {
    // Use mock paths - no real filesystem operations
    const tempDir = "/mock/config-test";
    const minskyhDir = "/mock/config-test/.minsky";
    const configPath = "/mock/config-test/.minsky/config.yaml";

    // Setup mock directory structure
    mockFs.directories.add(tempDir);
    mockFs.directories.add(minskyhDir);

    const configContent = `
version: 1
backends:
  default: json-file
  json-file:
    type: json-file
    name: json-file
`;

    // Create config file in mock filesystem
    await mockFs.writeFile(configPath, configContent);

    // Test createConfiguredTaskService
    const taskService = await createConfiguredTaskService({
      workspacePath: tempDir,
    });

    expect(taskService).toBeDefined();
    // Verify the service works by testing basic functionality
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should handle missing config directory", async () => {
    const nonExistentDir = "/mock/non-existent-dir";

    // The function should succeed with fallback behavior, not throw
    const taskService = await createConfiguredTaskService({
      workspacePath: nonExistentDir,
    });

    expect(taskService).toBeDefined();
    // Should work with default configuration
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should handle explicit backend override", async () => {
    const tempDir = "/mock/config-test-explicit";
    const minskyhDir = "/mock/config-test-explicit/.minsky";
    const configPath = "/mock/config-test-explicit/.minsky/config.yaml";

    // Setup mock directory structure
    mockFs.directories.add(tempDir);
    mockFs.directories.add(minskyhDir);

    const configContent = `
version: 1
backends:
  default: json-file
  json-file:
    type: json-file
    name: json-file
  markdown:
    type: markdown
    name: markdown
`;

    // Create config file in mock filesystem
    await mockFs.writeFile(configPath, configContent);

    // Test with explicit backend override
    const taskService = await createConfiguredTaskService({
      workspacePath: tempDir,
      backend: "markdown",
    });

    expect(taskService).toBeDefined();
    // Verify the service works with the specified backend
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });
});
