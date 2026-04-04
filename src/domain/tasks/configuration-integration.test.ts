/**
 * Integration test for configuration + task service
 *
 * These tests verify that createConfiguredTaskService works end-to-end
 * with real filesystem, configuration, and graceful fallbacks.
 *
 * NO MOCKS — the function is designed to handle missing config, missing
 * persistence, and missing git gracefully via try/catch fallbacks.
 * Previous mock-based approach caused module system poisoning (mt#660).
 */

import { test, expect, describe } from "bun:test";
import { createConfiguredTaskService } from "./taskService";

describe("Configuration Integration", () => {
  test("createConfiguredTaskService should create a working service from workspace", async () => {
    const taskService = await createConfiguredTaskService({
      // eslint-disable-next-line custom/no-real-fs-in-tests -- integration test requires real config
      workspacePath: process.cwd(),
    });

    expect(taskService).toBeDefined();
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should handle missing config directory", async () => {
    // Use a path that exists but has no .minsky config — function should fall back gracefully
    // eslint-disable-next-line custom/no-real-fs-in-tests -- integration test requires real config
    const emptyDir = `/tmp/minsky-test-${Date.now()}`;

    const taskService = await createConfiguredTaskService({
      workspacePath: emptyDir,
    });

    expect(taskService).toBeDefined();
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });

  test("createConfiguredTaskService should handle explicit backend override", async () => {
    const taskService = await createConfiguredTaskService({
      // eslint-disable-next-line custom/no-real-fs-in-tests -- integration test requires real config
      workspacePath: process.cwd(),
      backend: "markdown",
    });

    expect(taskService).toBeDefined();
    const tasks = await taskService.listTasks();
    expect(Array.isArray(tasks)).toBe(true);
  });
});
