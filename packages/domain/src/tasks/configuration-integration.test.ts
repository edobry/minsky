/**
 * Integration test for configuration + task service
 *
 * These tests verify that createConfiguredTaskService works end-to-end
 * with real filesystem, configuration, and graceful fallbacks.
 *
 * NO MOCKS — the function is designed to handle missing config, missing
 * persistence, and missing git gracefully via try/catch fallbacks.
 * Previous mock-based approach caused module system poisoning (mt#660).
 *
 * mt#3636 — "graceful" is scoped to CONSTRUCTION, not to reads. Building the
 * service against a provider that cannot back a task backend still succeeds
 * (so `/health` and non-DB commands keep working, per mt#2349), but a READ on
 * the resulting zero-backend service now RAISES instead of returning `[]`.
 * These two tests previously asserted `Array.isArray(tasks)` — the fail-open
 * contract where an unreachable database is indistinguishable from an empty
 * one. That is the defect mt#3636 fixes, so they now assert the guard.
 */

import { test, expect, describe } from "bun:test";
import { createConfiguredTaskService } from "./taskService";
import { FakePersistenceProvider } from "../persistence/fake-persistence-provider";

describe("Configuration Integration", () => {
  test("createConfiguredTaskService should create a working service from workspace", async () => {
    const taskService = await createConfiguredTaskService({
      // eslint-disable-next-line custom/no-real-fs-in-tests -- integration test requires real config
      workspacePath: process.cwd(),
      persistenceProvider: new FakePersistenceProvider(),
    });

    expect(taskService).toBeDefined();
    // Construction succeeds; the read fails closed and names why (mt#3636).
    await expect(taskService.listTasks()).rejects.toThrow(/Task backend unavailable/);
  });

  test("createConfiguredTaskService should handle missing config directory", async () => {
    // Use a non-existent path — function falls back gracefully when config is missing
    const emptyDir = "/mock/nonexistent/minsky-test-workspace";

    const taskService = await createConfiguredTaskService({
      workspacePath: emptyDir,
      persistenceProvider: new FakePersistenceProvider(),
    });

    expect(taskService).toBeDefined();
    await expect(taskService.listTasks()).rejects.toThrow(/Task backend unavailable/);
  });

  test("createConfiguredTaskService should reject unknown backend with clear error", async () => {
    // Verify that an unknown backend produces a clear error message
    await expect(
      createConfiguredTaskService({
        workspacePath: "/mock/workspace",
        backend: "unknown-backend",
        persistenceProvider: new FakePersistenceProvider(),
      })
    ).rejects.toThrow(/Unknown backend/);
  });
});
