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
import { TasksMigrateBackendCommand } from "./migrate-backend-command";
import { mockModule, createMock } from "../../../../utils/test-utils/mocking";
import type { CommandExecutionContext } from "../../command-registry";
import type { TaskServiceInterface } from "../../../../domain/tasks";

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

      expect(typeof (command as any).validateMigration).toBe("function");
    });

    it("should call validateMigration after migration is complete", async () => {
      // Mock the validateMigration method to verify it gets called
      const validateSpy = mock(() => Promise.resolve({ passed: [], failed: [] }));
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = validateSpy;

      // Mock the migrateTasksBetweenBackends method to avoid database calls
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = mock(() =>
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
            from: "markdown",
            to: "minsky",
            execute: true,
          },
          mockContext
        );

        // Verify validateMigration was called (this proves the bug is fixed)
        expect(validateSpy).toHaveBeenCalled();
      } finally {
        // Restore original methods
        (command as any).validateMigration = originalValidate;
        (command as any).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should fail migration when validation detects missing tasks in target backend", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = mock(() =>
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
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = mock(() =>
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
              from: "markdown",
              to: "minsky",
              execute: true,
            },
            mockContext
          );
        } catch (error) {
          threwError = true;
          // The command should throw an error when validation fails
          expect(error.message).toContain("Post-migration validation failed");
          expect(error.message).toContain("2 tasks failed validation");
        }

        // Should either throw error or return failure result
        expect(threwError || (result && !result.success)).toBe(true);
      } finally {
        (command as any).validateMigration = originalValidate;
        (command as any).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should fail migration when validation detects content mismatches", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = mock(() =>
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
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = mock(() =>
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
              from: "markdown",
              to: "minsky",
              execute: true,
            },
            mockContext
          );
        } catch (error) {
          threwError = true;
          // The command should throw an error when validation fails
          expect(error.message).toContain("Post-migration validation failed");
          expect(error.message).toContain("1 tasks failed validation");
        }

        // Should either throw error or return failure result
        expect(threwError || (result && !result.success)).toBe(true);
      } finally {
        (command as any).validateMigration = originalValidate;
        (command as any).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should succeed when all migrated tasks pass validation", async () => {
      // Mock migration to report successful migrations
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = mock(() =>
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
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = mock(() =>
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
            from: "markdown",
            to: "minsky",
            execute: true,
            json: true, // Use JSON format to get flat result structure
          },
          mockContext
        );

        // Should succeed when all validations pass
        expect(result.success).toBe(true);
        // DatabaseCommand returns flat structure, not nested under taskId
        expect(result.migrated).toBe(2);
        // Validation results are handled internally, not exposed in result
      } finally {
        (command as any).validateMigration = originalValidate;
        (command as any).migrateTasksBetweenBackends = originalMigrate;
      }
    });

    it("should skip validation in dry-run mode", async () => {
      // Mock migration for dry run
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = mock(() =>
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
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = validateSpy;

      try {
        const result = await command.execute(
          {
            from: "markdown",
            to: "minsky",
            execute: false, // dry run
          },
          mockContext
        );

        // Should succeed and NOT call validation in dry run
        expect(result.success).toBe(true);
        expect(validateSpy).not.toHaveBeenCalled();
      } finally {
        (command as any).validateMigration = originalValidate;
        (command as any).migrateTasksBetweenBackends = originalMigrate;
      }
    });
  });
});
