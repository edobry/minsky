/**
 * Database Command Example
 * 
 * This file demonstrates how to create commands using the new type-safe 
 * DatabaseCommand architecture with guaranteed provider injection.
 */

import { z } from "zod";
import { DatabaseCommand, DatabaseCommandContext } from "../database-command";
import { CommandCategory } from "../../../adapters/shared/command-registry";

/**
 * Example 1: Simple Database Query Command
 * 
 * This example shows a basic database command that queries session information.
 * The provider is automatically injected by the CommandDispatcher.
 */
export class ListSessionsCommand extends DatabaseCommand {
  readonly id = "sessions.list";
  readonly category = CommandCategory.SESSION;
  readonly name = "list";
  readonly description = "List sessions with optional filtering";

  readonly parameters = {
    limit: {
      schema: z.number().min(1).max(100),
      spec: "Maximum number of sessions to return",
      required: false,
      defaultValue: 10,
    },
    includeArchived: {
      schema: z.boolean(),
      spec: "Include archived sessions in results", 
      required: false,
      defaultValue: false,
    },
  } as const;

  async execute(
    params: { limit: number; includeArchived: boolean },
    context: DatabaseCommandContext
  ) {
    // Provider is guaranteed to be available and initialized
    const { provider } = context;
    
    // Use the provider for database operations
    const query = `
      SELECT id, name, created_at as "createdAt"
      FROM sessions 
      ${params.includeArchived ? "" : "WHERE archived = false"}
      ORDER BY created_at DESC 
      LIMIT $1
    `;
    
    const result = await provider.query(query, [params.limit]);
    return result.rows;
  }
}

/**
 * Example 2: Complex Database Operations Command
 * 
 * This example shows a command that performs multiple database operations
 * and demonstrates transaction handling with the injected provider.
 */
export class UpdateTaskStatusCommand extends DatabaseCommand {
  readonly id = "tasks.update-status";
  readonly category = CommandCategory.TASKS;
  readonly name = "update-status";
  readonly description = "Update task status with validation";

  readonly parameters = {
    taskId: {
      schema: z.string().regex(/^(mt|md)#\d+$/),
      spec: "Task ID in format mt#123 or md#123",
      required: true,
    },
    status: {
      schema: z.enum(["TODO", "IN_PROGRESS", "DONE", "BLOCKED"]),
      spec: "New status for the task",
      required: true,
    },
    reason: {
      schema: z.string().max(200).optional(),
      spec: "Optional reason for status change",
      required: false,
    },
  } as const;

  async execute(
    params: { taskId: string; status: string; reason?: string },
    context: DatabaseCommandContext
  ) {
    const { provider } = context;

    try {
      // Check if task exists and get current status
      const currentTask = await provider.query(
        `SELECT status FROM tasks WHERE id = $1`,
        [params.taskId]
      );

      if (currentTask.rows.length === 0) {
        throw new Error(`Task not found: ${params.taskId}`);
      }

      const previousStatus = currentTask.rows[0].status;

      // Update the task status
      const updateResult = await provider.query(
        `UPDATE tasks 
         SET status = $1, updated_at = NOW() 
         WHERE id = $2`,
        [params.status, params.taskId]
      );

      // Log the status change if reason provided
      if (params.reason) {
        await provider.query(
          `INSERT INTO task_status_log (task_id, old_status, new_status, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [params.taskId, previousStatus, params.status, params.reason]
        );
      }

      return {
        updated: updateResult.affectedRows > 0,
        previousStatus,
      };
    } catch (error) {
      // Handle database-specific errors with meaningful messages
      if (error instanceof Error && error.message.includes("constraint")) {
        throw new Error(`Invalid status transition for task ${params.taskId}`);
      }
      throw error; // Re-throw other errors
    }
  }
}

/**
 * Migration Notes:
 * 
 * OLD PATTERN (to be replaced):
 * ```typescript
 * async function myCommandHandler(params: any, context: CommandExecutionContext) {
 *   await PersistenceService.initialize(); // Manual initialization
 *   const provider = PersistenceService.getProvider();
 *   // ... use provider
 * }
 * ```
 * 
 * NEW PATTERN:
 * ```typescript
 * class MyDatabaseCommand extends DatabaseCommand {
 *   async execute(params: MyParams, context: DatabaseCommandContext) {
 *     const { provider } = context; // Automatically injected and initialized
 *     // ... use provider
 *   }
 * }
 * ```
 */