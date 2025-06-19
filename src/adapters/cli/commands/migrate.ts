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
    .option("--preserve-ids", "Preserve task IDs during migration", false)
    .option("--map-status <mapping...>", 'Custom status mapping (format: "OLD=NEW")')
    .option(
      "--id-conflict-strategy <strategy>",
      "How to handle ID conflicts (skip, rename, overwrite)",
      "skip"
    )
    .option("--no-rollback-on-failure", "Disable rollback on migration failure")
    .option("--no-create-backup", "Skip creating backup before migration")
    .option("--interactive", "Interactive mode with confirmation prompts", false)
    .action(async (options: MigrateCommandOptions) => {
      try {
        await executeMigrateCommand(options);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.cliError(`Migration failed: ${errorMessage}`);
        throw new Error(errorMessage);
      }
    });

  return command;
}

/**
 * Execute the migrate command
 */
async function executeMigrateCommand(options: MigrateCommandOptions): Promise<void> {
  const {
    from,
    to,
    dryRun = false,
    preserveIds = false,
    mapStatus = [],
    idConflictStrategy = "skip",
    rollbackOnFailure = true,
    createBackup = true,
    interactive = false,
  } = options;

  // Validate backends
  const validBackends = ["markdown", "json-file", "github-issues"];
  if (!validBackends.includes(from)) {
    throw new Error(`Invalid source backend: ${from}. Must be one of: ${validBackends.join(", ")}`);
  }
  if (!validBackends.includes(to)) {
    throw new Error(`Invalid target backend: ${to}. Must be one of: ${validBackends.join(", ")}`);
  }
  if (from === to) {
    throw new Error("Source and target backends cannot be the same");
  }

  // Parse status mapping
  const statusMapping: Record<string, string> = {};
  for (const mapping of mapStatus) {
    const [oldStatus, newStatus] = mapping.split("=");
    if (!oldStatus || !newStatus) {
      throw new Error(`Invalid status mapping format: ${mapping}. Use format "OLD=NEW"`);
    }
    statusMapping[oldStatus] = newStatus;
  }

  // Validate ID conflict strategy
  if (!["skip", "rename", "overwrite"].includes(idConflictStrategy)) {
    throw new Error(
      `Invalid ID conflict strategy: ${idConflictStrategy}. Must be one of: skip, rename, overwrite`
    );
  }

  log.cli(`Starting migration from ${from} to ${to}...`);
  if (dryRun) {
    log.cli("Running in DRY RUN mode - no changes will be made");
  }

  // Create task services for source and target backends
  const sourceService = new TaskService({ backend: from });
  const targetService = new TaskService({ backend: to });

  // For proper backend access, we need to access the internal backends
  // This is a bit of a hack, but necessary given the current architecture
  const sourceBackendInstance = (sourceService as any).currentBackend;
  const targetBackendInstance = (targetService as any).currentBackend;

  if (!sourceBackendInstance || !targetBackendInstance) {
    throw new Error("Failed to initialize backend instances");
  }

  // Interactive confirmation
  if (interactive && !dryRun) {
    const confirmed = await promptConfirmation(
      `Are you sure you want to migrate tasks from ${from} to ${to}? This will modify your task data.`
    );
    if (!confirmed) {
      log.cli("Migration cancelled by user");
      return;
    }
  }

  // Perform migration
  const migrationUtils = new BackendMigrationUtils();
  const result = await migrationUtils.migrateTasksBetweenBackends(
    sourceBackendInstance,
    targetBackendInstance,
    {
      preserveIds,
      dryRun,
      statusMapping,
      rollbackOnFailure,
      idConflictStrategy: idConflictStrategy as "skip" | "rename" | "overwrite",
      createBackup,
    }
  );

  // Report results
  if (result.success) {
    log.cli(`✅ ${result.summary}`);
    if (result.migratedCount > 0) {
      log.cli(`📊 Migrated: ${result.migratedCount} tasks`);
    }
    if (result.skippedCount > 0) {
      log.cli(`⏭️  Skipped: ${result.skippedCount} tasks`);
    }
    if (dryRun) {
      log.cli("💡 Run without --dry-run to perform the actual migration");
    }
  } else {
    log.cliError(`❌ ${result.summary}`);
    if (result.errors.length > 0) {
      log.cliError("Errors:");
      result.errors.forEach((error) => log.cliError(`  - ${error}`));
    }
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
  } catch (error) {
    // Fallback - just log warning and proceed
    log.cliWarn("Interactive prompts not available. Proceeding with migration...");
    log.cli(`Confirmation requested: ${message}`);
    return true;
  }
}

export default createMigrateCommand;
