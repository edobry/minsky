/**
 * CLI command for migrating tasks between backends
 */

import { Command } from "commander";
import { BackendMigrationUtils } from "../../../domain/tasks/migrationUtils";
import { TaskService } from "../../../domain/tasks/taskService";
import { log } from "../../../utils/logger";

/**
 * Options for the migrate command
 */
interface MigrateCommandOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  preserveIds?: boolean;
  mapStatus?: string[];
  idConflictStrategy?: "skip" | "rename" | "overwrite";
  rollbackOnFailure?: boolean;
  createBackup?: boolean;
  interactive?: boolean;
}

/**
 * Create and configure the migrate command
 */
export function createMigrateCommand(): Command {
  const command = new Command("migrate");

  command
    .description("Migrate tasks between different backends")
    .requiredOption("--from <backend>", "Source backend (markdown, json-file, github-issues)")
    .requiredOption("--to <backend>", "Target backend (markdown, json-file, github-issues)")
    .option("--dry-run", "Preview migration without making changes", false)
    .option("--preserve-ids", "Preserve original task IDs", true)
    .option("--map-status <mapping...>", "Custom status mapping (format: \"OLD=NEW\")")
    .option("--id-conflict-strategy <strategy>", "Strategy for ID conflicts", "skip")
    .option("--rollback-on-failure", "Rollback changes on failure", true)
    .option("--create-backup", "Create backup before migration", true)
    .option("--interactive", "Interactive confirmation prompts", false)
    .action(handleMigrateCommand);

  return command;
}

/**
 * Handle the migrate command execution
 */
async function handleMigrateCommand(options: MigrateCommandOptions): Promise<void> {
  try {
    // Parse status mapping
    const statusMapping: Record<string, string> = {};
    if (options.mapStatus) {
      for (const mapping of options.mapStatus) {
        const [from, to] = mapping.split("=");
        if (from && to) {
          statusMapping[from.trim()] = to.trim();
        }
      }
    }

    // Validate backend names
    const validBackends = ["markdown", "json-file", "github-issues"];
    if (!validBackends.includes(options.from)) {
      throw new Error(
        `Invalid source backend: ${options.from}. Valid options: ${validBackends.join(", ")}`
      );
    }
    if (!validBackends.includes(options.to)) {
      throw new Error(
        `Invalid target backend: ${options.to}. Valid options: ${validBackends.join(", ")}`
      );
    }

    // Create task services for source and target backends
    const sourceService = new TaskService({ backend: options.from });
    const targetService = new TaskService({ backend: options.to });

    // For proper backend access, we need to access the internal backends
    // This is a bit of a hack, but necessary given the current architecture
    const sourceBackendInstance = (sourceService as any).currentBackend;
    const targetBackendInstance = (targetService as any).currentBackend;

    if (!sourceBackendInstance || !targetBackendInstance) {
      throw new Error("Failed to initialize backend instances");
    }

    // Initialize migration utils
    const migrationUtils = new BackendMigrationUtils();

    // Interactive confirmation if requested
    if (options.interactive && !options.dryRun) {
      const confirmed = await promptConfirmation(
        `Migrate tasks from ${options.from} to ${options.to}?`
      );
      if (!confirmed) {
        log.cli("Migration cancelled by user");
        return;
      }
    }

    // Perform migration
    log.cli(`Starting migration from ${options.from} to ${options.to}...`);

    const migrationOptions = {
      preserveIds: options.preserveIds ?? true,
      dryRun: options.dryRun ?? false,
      statusMapping,
      idConflictStrategy: (options.idConflictStrategy as "skip" | "rename" | "overwrite") ?? "skip",
      rollbackOnFailure: options.rollbackOnFailure ?? true,
      createBackup: options.createBackup ?? true,
    };

    const result = await migrationUtils.migrateTasksBetweenBackends(
      sourceBackendInstance,
      targetBackendInstance,
      migrationOptions
    );

    // Report results
    if (result.success) {
      log.cli("Migration completed successfully!");
      log.cli(`  - Migrated: ${result.migratedCount} tasks`);
      log.cli(`  - Skipped: ${result.skippedCount} tasks`);

      if (result.backupPath) {
        log.cli(`  - Backup created: ${result.backupPath}`);
      }
    } else {
      log.cliError("Migration failed:");
      result.errors.forEach((error) => log.cliError(`  - ${error}`));
      throw new Error("Migration operation failed");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    log.cliError(`Migration failed: ${errorMessage}`);
    throw new Error(errorMessage);
  }
}

/**
 * Prompt user for confirmation
 */
async function promptConfirmation(message: string): Promise<boolean> {
  // Import prompts dynamically to avoid dependency issues
  try {
    const { confirm } = await import("@clack/prompts");
    const result = await confirm({ message });
    return Boolean(result);
  } catch (_error) {
    // Fallback - just log warning and proceed
    log.cliWarn("Interactive prompts not available. Proceeding with migration...");
    log.cli(`Confirmation requested: ${message}`);
    return true;
  }
}
