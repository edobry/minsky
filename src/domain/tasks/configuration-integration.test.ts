/**
 * Test for configuration integration with task service
 *
 * These tests verify that the configuration system properly integrates
 * with task service creation and backend resolution.
 *
 * NOTE: These tests depend on local environment (config files, git repo).
 * They are skipped in CI where these aren't available. The proper fix is
 * dependency injection (tracked in mt#660) — these tests should be
 * rewritten to use explicit DI once that infrastructure exists.
 */

import { test, expect, describe } from "bun:test";
import { createConfiguredTaskService } from "./taskService";

// Detect CI environment — these tests require local config that CI doesn't have
const isCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS;

describe("Configuration Integration", () => {
  test.skipIf(isCI)(
    "createConfiguredTaskService should use configuration to resolve backend",
    async () => {
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
      });

      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    }
  );

  test.skipIf(isCI)(
    "createConfiguredTaskService should handle missing config directory",
    async () => {
      const taskService = await createConfiguredTaskService({
        workspacePath: "/tmp/nonexistent-dir-for-test",
      });

      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    }
  );

  test.skipIf(isCI)(
    "createConfiguredTaskService should handle explicit backend override",
    async () => {
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      });

      expect(taskService).toBeDefined();
      const tasks = await taskService.listTasks();
      expect(Array.isArray(tasks)).toBe(true);
    }
  );
});
