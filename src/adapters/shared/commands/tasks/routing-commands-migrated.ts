/**
 * Migrated Routing Commands
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
import { TaskRoutingService } from "../../../../domain/tasks/task-routing-service";
import { createConfiguredTaskService } from "../../../../domain/tasks/taskService";

/**
 * MIGRATED: Tasks Available Command
 *
 * OLD: Used PersistenceService.getProvider() directly
 * NEW: Extends DatabaseCommand, receives provider via context
 */
export class TasksAvailableCommand extends DatabaseCommand {
  readonly id = "tasks.available";
  readonly category = CommandCategory.TASKS;
  readonly name = "available";
  readonly description = "Show tasks currently available to work on (unblocked by dependencies)";

  readonly parameters = {
    status: {
      schema: z.string().optional(),
      spec: "Filter by task status (default: TODO,IN-PROGRESS)",
      required: false,
    },
    backend: {
      schema: z.string().optional(),
      spec: "Filter by specific backend (mt, md, gh, etc.)",
      required: false,
    },
    limit: {
      schema: z.number().default(20),
      spec: "Maximum number of tasks to show",
      required: false,
      defaultValue: 20,
    },
    showEffort: {
      schema: z.boolean().default(false),
      spec: "Include effort estimates if available",
      required: false,
      defaultValue: false,
    },
    showPriority: {
      schema: z.boolean().default(false),
      spec: "Include priority information if available",
      required: false,
      defaultValue: false,
    },
    json: {
      schema: z.boolean().default(false),
      spec: "Output in JSON format",
      required: false,
      defaultValue: false,
    },
    minReadiness: {
      schema: z.number().min(0).max(1).default(1.0),
      spec: "Minimum readiness score (0.0-1.0) - use 1.0 for truly available tasks only",
      required: false,
      defaultValue: 1.0,
    },
  } as const;

  async execute(
    params: {
      status?: string;
      backend?: string;
      limit: number;
      showEffort: boolean;
      showPriority: boolean;
      json: boolean;
      minReadiness: number;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    if (!provider.capabilities.sql) {
      throw new Error("Current persistence provider does not support SQL operations");
    }

    const db = await provider.getDatabaseConnection?.();
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    const graphService = new TaskGraphService(db as PostgresJsDatabase);
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    const routingService = new TaskRoutingService(graphService, taskService);

    // Parse status filter
    const statusFilter = params.status
      ? params.status.split(",").map((s: string) => s.trim())
      : ["TODO", "IN-PROGRESS"];

    let availableTasks;
    try {
      availableTasks = await routingService.findAvailableTasks({
        statusFilter,
        backendFilter: params.backend,
        limit: params.limit,
        showEffort: params.showEffort,
        showPriority: params.showPriority,
        minReadiness: params.minReadiness,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table: task_relationships")) {
        return {
          count: 0,
          tasks: [],
          message: "No task relationships found. Run 'tasks deps --help' to set up dependencies.",
        };
      }
      throw error;
    }

    return {
      count: availableTasks.length,
      tasks: availableTasks,
      filters: {
        status: statusFilter,
        backend: params.backend,
        limit: params.limit,
        minReadiness: params.minReadiness,
      },
    };
  }
}

/**
 * MIGRATED: Tasks Route Command
 *
 * OLD: Used PersistenceService.getProvider() directly
 * NEW: Extends DatabaseCommand, receives provider via context
 */
export class TasksRouteCommand extends DatabaseCommand {
  readonly id = "tasks.route";
  readonly category = CommandCategory.TASKS;
  readonly name = "route";
  readonly description = "Generate implementation route to target task";

  readonly parameters = {
    target: {
      schema: z.string(),
      spec: "Target task ID to route to",
      required: true,
    },
    strategy: {
      schema: z.enum(["shortest-path", "value-first", "ready-first"]).default("ready-first"),
      spec: "Routing strategy to use",
      required: false,
      defaultValue: "ready-first" as const,
    },
    parallel: {
      schema: z.boolean().default(false),
      spec: "Show parallel execution opportunities",
      required: false,
      defaultValue: false,
    },
    json: {
      schema: z.boolean().default(false),
      spec: "Output in JSON format",
      required: false,
      defaultValue: false,
    },
  } as const;

  async execute(
    params: {
      target: string;
      strategy: "shortest-path" | "value-first" | "ready-first";
      parallel: boolean;
      json: boolean;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    if (!provider.capabilities.sql) {
      throw new Error("Current persistence provider does not support SQL operations");
    }

    const db = await provider.getDatabaseConnection?.();
    if (!db) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    const graphService = new TaskGraphService(db as PostgresJsDatabase);
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    const routingService = new TaskRoutingService(graphService, taskService);

    try {
      const route = await routingService.generateRoute(params.target, {
        strategy: params.strategy,
        showParallel: params.parallel,
      });

      return {
        target: params.target,
        strategy: params.strategy,
        route,
        stats: {
          totalSteps: route.steps.length,
          readyTasks: route.stats.readyTasks,
          blockedTasks: route.stats.blockedTasks,
          estimatedEffort: route.stats.estimatedEffort,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("no such table: task_relationships")) {
        return {
          target: params.target,
          error: "No task relationships found. Run 'tasks deps --help' to set up dependencies.",
          route: null,
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
 * 4. Added proper TypeScript typing for parameters
 * 5. Used Zod schemas with defaultValue instead of .default()
 *
 * BENEFITS:
 * - Automatic provider initialization via CommandDispatcher
 * - Type-safe parameter handling
 * - Clean dependency injection for testing
 * - No manual PersistenceService calls needed
 */
