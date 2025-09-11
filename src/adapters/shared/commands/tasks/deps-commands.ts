/**
 * Migrated Dependency Commands
 *
 * These commands migrate from the old pattern (direct PersistenceService.getProvider() calls)
 * to the new DatabaseCommand pattern with automatic provider injection.
 */

import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DatabaseCommand,
  DatabaseCommandContext,
} from "../../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";

/**
 * MIGRATED: Tasks Deps Add Command
 *
 * OLD: Used PersistenceService.getProvider() directly
 * NEW: Extends DatabaseCommand, receives provider via context
 */
export class TasksDepsAddCommand extends DatabaseCommand {
  readonly id = "tasks.deps.add";
  readonly category = CommandCategory.TASKS;
  readonly name = "add";
  readonly description = "Add a dependency edge (task depends on prerequisite)";

  readonly parameters = {
    task: {
      schema: z.string(),
      spec: "Task ID that should depend on the prerequisite",
      required: true,
    },
    dependsOn: {
      schema: z.string(),
      spec: "Task ID that is a prerequisite for the task",
      required: true,
    },
  } as const;

  async execute(
    params: {
      task: string;
      dependsOn: string;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    const db = await provider.getDatabaseConnection?.();
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    const service = new TaskGraphService(db as PostgresJsDatabase);
    const result = await service.addDependency(params.task, params.dependsOn);

    const output = result.created
      ? `✅ Added dependency: ${params.task} depends on ${params.dependsOn}`
      : `ℹ️  Dependency already exists: ${params.task} depends on ${params.dependsOn}`;

    return { success: true, output };
  }
}

/**
 * MIGRATED: Tasks Deps Remove Command
 *
 * OLD: Used PersistenceService.getProvider() directly
 * NEW: Extends DatabaseCommand, receives provider via context
 */
export class TasksDepsRmCommand extends DatabaseCommand {
  readonly id = "tasks.deps.rm";
  readonly category = CommandCategory.TASKS;
  readonly name = "rm";
  readonly description = "Remove a dependency edge";

  readonly parameters = {
    task: {
      schema: z.string(),
      spec: "Task ID to remove dependency from",
      required: true,
    },
    dependsOn: {
      schema: z.string(),
      spec: "Task ID that is currently a prerequisite",
      required: true,
    },
  } as const;

  async execute(
    params: {
      task: string;
      dependsOn: string;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    const db = await provider.getDatabaseConnection?.();
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    const service = new TaskGraphService(db as PostgresJsDatabase);
    const result = await service.removeDependency(params.task, params.dependsOn);

    const output = result.removed
      ? `✅ Removed dependency: ${params.task} no longer depends on ${params.dependsOn}`
      : `ℹ️  Dependency did not exist: ${params.task} was not depending on ${params.dependsOn}`;

    return { success: true, output };
  }
}

/**
 * MIGRATED: Tasks Deps List Command
 *
 * OLD: Used PersistenceService.getProvider() directly
 * NEW: Extends DatabaseCommand, receives provider via context
 */
export class TasksDepsListCommand extends DatabaseCommand {
  readonly id = "tasks.deps.list";
  readonly category = CommandCategory.TASKS;
  readonly name = "list";
  readonly description = "List dependencies for a task";

  readonly parameters = {
    task: {
      schema: z.string(),
      spec: "Task ID to list dependencies for",
      required: true,
    },
    verbose: {
      schema: z.boolean().default(false),
      spec: "Use more detailed output format",
      required: false,
      defaultValue: false,
    },
  } as const;

  async execute(
    params: {
      task: string;
      verbose: boolean;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    const db = await provider.getDatabaseConnection?.();
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    const service = new TaskGraphService(db as PostgresJsDatabase);

    try {
      // Get dependencies (tasks this task depends on)
      const dependencies = await service.listDependencies(params.task);

      // Get dependents (tasks that depend on this task) if verbose
      const dependents = params.verbose ? await service.listDependents(params.task) : [];

      if (!params.verbose) {
        // Simple format - just list dependencies
        if (dependencies.length === 0) {
          return {
            task: params.task,
            dependencies: [],
            message: `Task ${params.task} has no dependencies`,
          };
        }

        return {
          task: params.task,
          dependencies: dependencies,
          count: dependencies.length,
        };
      } else {
        // Verbose format - include both dependencies and dependents
        return {
          task: params.task,
          dependencies: {
            incoming: dependencies,
            outgoing: dependents,
          },
          counts: {
            dependsOn: dependencies.length,
            dependedUponBy: dependents.length,
          },
        };
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table: task_relationships")) {
        return {
          task: params.task,
          error: "No task relationships found. Dependencies have not been set up yet.",
          dependencies: [],
        };
      }
      throw error;
    }
  }
}

/**
 * MIGRATION SUMMARY:
 *
 * CHANGES MADE:
 * 1. Converted factory functions to DatabaseCommand classes
 * 2. Removed direct PersistenceService.getProvider() calls
 * 3. Added provider via context injection: const { provider } = context
 * 4. Added proper TypeScript typing for parameters and results
 * 5. Used Zod schemas with defaultValue instead of .default()
 * 6. Enhanced error handling for missing tables
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 */
