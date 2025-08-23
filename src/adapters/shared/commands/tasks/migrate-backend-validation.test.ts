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

import { describe, it, expect, beforeEach } from "bun:test";
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
      const validateSpy = createMock(() => Promise.resolve({ passed: [], failed: [] }));
      const originalValidate = (command as any).validateMigration;
      (command as any).validateMigration = validateSpy;
      
      // Mock the migrateTasksBetweenBackends method to avoid database calls
      const originalMigrate = (command as any).migrateTasksBetweenBackends;
      (command as any).migrateTasksBetweenBackends = createMock(() => Promise.resolve({
        total: 0,
        migrated: 0,
        skipped: 0,
        errors: 0,
        details: [], // No migrated tasks, so validation should still be called but with empty list
      }));

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
  });
});
