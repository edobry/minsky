/**
 * Migration Backend Validation Bug Fix
 *
 * BUG: Migration command does not perform post-migration validation by default
 *
 * Current Behavior:
 * - Migration reports "success" even when tasks fail to migrate
 * - No verification that reported "migrated" tasks actually exist in target backend
 * - No detailed reporting of EXACTLY which tasks failed and why
 * - Users must manually verify migration success
 *
 * Expected Behavior:
 * - Migration should automatically verify all "migrated" tasks exist in target backend
 * - Should report EXACTLY which tasks failed with specific reasons
 * - Should fail the entire migration if verification finds discrepancies
 * - Should provide actionable error messages for each failed task
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { TasksMigrateBackendCommand, type MigrateBackendParams } from "./migrate-backend-command";
import { mockModule, createMock } from "../../../../utils/test-utils/mocking";
import type { CommandExecutionContext } from "../../command-registry";
import type { TaskServiceInterface } from "../../../../domain/tasks";
import { TaskBackend } from "../../../../domain/configuration/backend-detection";

// Type helper for accessing private methods on TasksMigrateBackendCommand
type CommandWithPrivates = {
  validateMigration: (...args: unknown[]) => Promise<{ passed: unknown[]; failed: unknown[] }>;
  migrateTasksBetweenBackends: (...args: unknown[]) => Promise<unknown>;
};

// Mock the logger module to prevent "log.cli is not a function" errors
mock.module("../../../../utils/logger", () => ({
  log: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    agent: mock(() => {}),
    cli: mock(() => {}),
    cliWarn: mock(() => {}),
    cliError: mock(() => {}),
    cliDebug: mock(() => {}),
    systemDebug: mock(() => {}),
    setLevel: mock(() => {}),
    mode: "HUMAN",
    isStructuredMode: mock(() => false),
    isHumanMode: mock(() => true),
  },
}));

describe("Migration Backend Validation Bug Fix", () => {
  let command: TasksMigrateBackendCommand;
  let mockContext: CommandExecutionContext;

  beforeEach(() => {
    command = new TasksMigrateBackendCommand();
    mockContext = {
      workspacePath: "/test/workspace",
      format: "cli",
    };
  });

  describe("BUG REPRODUCTION: Missing Post-Migration Validation", () => {
    it("should perform post-migration validation by default", async () => {
      // SIMPLE TEST: Just verify that the command has a validation method
      // This should fail because currently there's no validation

      expect(typeof (command as unknown as CommandWithPrivates).validateMigration).toBe("function");
    });

    it("should call validateMigration after migration is complete", async () => {
      // Mock the validateMigration method to verify it gets called
      const validateSpy = mock(() => Promise.resolve({ passed: [], failed: [] }));
      const originalValidate = (command as unknown as CommandWithPrivates).validateMigration;
      (command as unknown as CommandWithPrivates).validateMigration = validateSpy;

      // Mock the migrateTasksBetweenBackends method to avoid database calls
      const originalMigrate = (command as unknown as CommandWithPrivates)
        .migrateTasksBetweenBackends;
      (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = mock(() =>
        Promise.resolve({
          total: 0,
          migrated: 0,
          skipped: 0,
          errors: 0,
          details: [], // No migrated tasks, so validation should still be called but with empty list
        })
      );

      try {
        await command.execute(
          {
            from: TaskBackend.MARKDOWN,
            to: TaskBackend.MINSKY,
            execute: true,
          } as unknown as MigrateBackendParams,
          mockContext
        );

        // Verify validateMigration was called (this proves the bug is fixed)
        expect(validateSpy).toHaveBeenCalled();
      } finally {
        // Restore original methods
        (command as unknown as CommandWithPrivates).validateMigration = originalValidate;
        (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should fail migration when validation detects missing tasks in target backend", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as unknown as CommandWithPrivates)
        .migrateTasksBetweenBackends;
      (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = mock(() =>
        Promise.resolve({
          total: 2,
          migrated: 2,
          skipped: 0,
          errors: 0,
          details: [
            { id: "md#100", status: "migrated" },
            { id: "md#101", status: "migrated" },
          ],
        })
      );

      // Mock validation to return failures
      const originalValidate = (command as unknown as CommandWithPrivates).validateMigration;
      (command as unknown as CommandWithPrivates).validateMigration = mock(() =>
        Promise.resolve({
          passed: [],
          failed: [
            {
              taskId: "md#100",
              targetTaskId: "mt#100",
              reason: "TASK_NOT_FOUND_IN_TARGET",
              details: "Task mt#100 was reported as migrated but does not exist in minsky backend",
            },
            {
              taskId: "md#101",
              targetTaskId: "mt#101",
              reason: "TASK_NOT_FOUND_IN_TARGET",
              details: "Task mt#101 was reported as migrated but does not exist in minsky backend",
            },
          ],
        })
      );

      try {
        let result;
        let threwError = false;

        try {
          result = await command.execute(
            {
              from: TaskBackend.MARKDOWN,
              to: TaskBackend.MINSKY,
              execute: true,
            } as unknown as MigrateBackendParams,
            mockContext
          );
        } catch (error) {
          threwError = true;
          // The command should throw an error when validation fails
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("Post-migration validation failed");
          expect(msg).toContain("2 tasks failed validation");
        }

        // Should either throw error or return failure result
        expect(threwError || (result && !result.success)).toBe(true);
      } finally {
        (command as unknown as CommandWithPrivates).validateMigration = originalValidate;
        (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should fail migration when validation detects content mismatches", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as unknown as CommandWithPrivates)
        .migrateTasksBetweenBackends;
      (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = mock(() =>
        Promise.resolve({
          total: 2,
          migrated: 2,
          skipped: 0,
          errors: 0,
          details: [
            { id: "md#200", status: "migrated" },
            { id: "md#201", status: "migrated" },
          ],
        })
      );

      // Mock validation to return mixed results
      const originalValidate = (command as unknown as CommandWithPrivates).validateMigration;
      (command as unknown as CommandWithPrivates).validateMigration = mock(() =>
        Promise.resolve({
          passed: [{ taskId: "md#200", targetTaskId: "mt#200", status: "VALIDATED" }],
          failed: [
            {
              taskId: "md#201",
              targetTaskId: "mt#201",
              reason: "TITLE_MISMATCH",
              details: 'Title mismatch: source="Original Title" vs target="Different Title"',
            },
          ],
        })
      );

      try {
        let result;
        let threwError = false;

        try {
          result = await command.execute(
            {
              from: TaskBackend.MARKDOWN,
              to: TaskBackend.MINSKY,
              execute: true,
            } as unknown as MigrateBackendParams,
            mockContext
          );
        } catch (error) {
          threwError = true;
          // The command should throw an error when validation fails
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("Post-migration validation failed");
          expect(msg).toContain("1 tasks failed validation");
        }

        // Should either throw error or return failure result
        expect(threwError || (result && !result.success)).toBe(true);
      } finally {
        (command as unknown as CommandWithPrivates).validateMigration = originalValidate;
        (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should succeed when all migrated tasks pass validation", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as unknown as CommandWithPrivates)
        .migrateTasksBetweenBackends;
      (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = mock(() =>
        Promise.resolve({
          total: 2,
          migrated: 2,
          skipped: 0,
          errors: 0,
          details: [
            { id: "md#300", status: "migrated" },
            { id: "md#301", status: "migrated" },
          ],
        })
      );

      // Mock validation to return all passed
      const originalValidate = (command as unknown as CommandWithPrivates).validateMigration;
      (command as unknown as CommandWithPrivates).validateMigration = mock(() =>
        Promise.resolve({
          passed: [
            { taskId: "md#300", targetTaskId: "mt#300", status: "VALIDATED" },
            { taskId: "md#301", targetTaskId: "mt#301", status: "VALIDATED" },
          ],
          failed: [],
        })
      );

      try {
        const result = await command.execute(
          {
            from: TaskBackend.MARKDOWN,
            to: TaskBackend.MINSKY,
            execute: true,
            json: true, // Use JSON format to get flat result structure
          } as unknown as MigrateBackendParams,
          mockContext
        );

        // Should succeed when all validations pass
        expect(result.success).toBe(true);
        expect((result as Record<string, unknown>).migrated).toBe(2);
        expect(
          ((result as Record<string, unknown>).validation as Record<string, unknown>).passed
        ).toHaveLength(2);
        expect(
          ((result as Record<string, unknown>).validation as Record<string, unknown>).failed
        ).toHaveLength(0);
      } finally {
        (command as unknown as CommandWithPrivates).validateMigration = originalValidate;
        (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should skip validation in dry-run mode", async () => {
      // Mock migration for dry run
      const originalMigrate = (command as unknown as CommandWithPrivates)
        .migrateTasksBetweenBackends;
      (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = mock(() =>
        Promise.resolve({
          total: 1,
          migrated: 0,
          skipped: 0,
          errors: 0,
          details: [],
        })
      );

      // Mock validation (should not be called in dry run)
      const validateSpy = mock(() => Promise.resolve({ passed: [], failed: [] }));
      const originalValidate = (command as unknown as CommandWithPrivates).validateMigration;
      (command as unknown as CommandWithPrivates).validateMigration = validateSpy;

      try {
        const result = await command.execute(
          {
            from: TaskBackend.MARKDOWN,
            to: TaskBackend.MINSKY,
            execute: false, // dry run
          } as unknown as MigrateBackendParams,
          mockContext
        );

        // Should succeed and NOT call validation in dry run
        expect(result.success).toBe(true);
        expect(validateSpy).not.toHaveBeenCalled();
      } finally {
        (command as unknown as CommandWithPrivates).validateMigration = originalValidate;
        (command as unknown as CommandWithPrivates).migrateTasksBetweenBackends = originalMigrate;
      }
    });
  });
});
