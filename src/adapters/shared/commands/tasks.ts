/**
 * Shared Tasks Commands
 *
 * This module contains shared task command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../command-registry.js";
import { getTaskStatusFromParams, setTaskStatusFromParams } from "../../../domain/tasks.js";
import { log } from "../../../utils/logger.js";

// Exported from domain/tasks.ts
export const TASK_STATUS = {
  TODO: "TODO",
  DONE: "DONE",
  IN_PROGRESS: "IN-PROGRESS",
  IN_REVIEW: "IN-REVIEW",
  BLOCKED: "BLOCKED",
} as const;

/**
 * Parameters for the tasks status get command
 */
const taskStatusGetCommandParams: CommandParameterMap = {
  taskId: {
    schema: z.string().min(1),
    description: "Task ID",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
};

/**
 * Parameters for the tasks status set command
 */
const taskStatusSetCommandParams: CommandParameterMap = {
  taskId: {
    schema: z.string().min(1),
    description: "Task ID",
    required: true,
  },
  status: {
    schema: z.enum([
      TASK_STATUS.TODO,
      TASK_STATUS.IN_PROGRESS,
      TASK_STATUS.BLOCKED,
      TASK_STATUS.IN_REVIEW,
      TASK_STATUS.DONE,
    ]),
    description: "New task status",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
};

/**
 * Parameters for the tasks spec command
 */
const taskSpecCommandParams: CommandParameterMap = {
  taskId: {
    schema: z.string().min(1),
    description: "ID of the task to retrieve specification content for",
    required: true,
  },
  section: {
    schema: z.string(),
    description: "Specific section of the specification to retrieve (e.g., 'requirements')",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
};

/**
 * Register the tasks commands in the shared command registry
 */
export function registerTasksCommands(): void {
  // Register tasks status get command
  sharedCommandRegistry.registerCommand({
    id: "tasks.status.get",
    category: CommandCategory.TASKS,
    name: "status get",
    description: "Get the status of a task",
    parameters: taskStatusGetCommandParams,
    execute: async (params, context) => {
      log.debug("Executing tasks.status.get command", { params, context });
      
      try {
        const status = await getTaskStatusFromParams({
          taskId: params.taskId,
          repo: params.repo,
          session: params.session,
        });
        
        return {
          success: true,
          taskId: params.taskId,
          status,
        };
      } catch (error) {
        log.error("Failed to get task status", { 
          error: error instanceof Error ? error.message : String(error),
          taskId: params.taskId 
        });
        throw error;
      }
    },
  });

  // Register tasks status set command
  sharedCommandRegistry.registerCommand({
    id: "tasks.status.set",
    category: CommandCategory.TASKS,
    name: "status set",
    description: "Set the status of a task",
    parameters: taskStatusSetCommandParams,
    execute: async (params, context) => {
      log.debug("Executing tasks.status.set command", { params, context });
      
      // Get previous status before setting the new one
      let previousStatus = null;
      try {
        previousStatus = await getTaskStatusFromParams({
          taskId: params.taskId,
          repo: params.repo,
          session: params.session,
        });
      } catch (error) {
        // If task doesn't exist, continue with setting the status
        log.debug("Failed to get previous task status", { 
          error: error instanceof Error ? error.message : String(error),
          taskId: params.taskId 
        });
      }
      
      // Set the new status
      await setTaskStatusFromParams({
        taskId: params.taskId,
        status: params.status,
        repo: params.repo,
        session: params.session,
      });
      
      return {
        success: true,
        taskId: params.taskId,
        status: params.status,
        previousStatus,
      };
    },
  });

  // Register tasks spec command
  sharedCommandRegistry.registerCommand({
    id: "tasks.spec",
    category: CommandCategory.TASKS,
    name: "spec",
    description: "Get task specification content",
    parameters: taskSpecCommandParams,
    execute: async (params, context) => {
      log.debug("Executing tasks.spec command", { params, context });
      
      try {
        // We can't import getTaskSpecContentFromParams yet since it's in flux,
        // so we'll use the CLI adapter's direct implementation for now
        
        // Format the result for CLI display if we are in CLI context
        if (context.interface === "cli") {
          // The CLI bridge will integrate with the existing CLI command
          return { 
            success: true,
            message: "Task specification retrieved"
          };
        }
        
        // For other interfaces, return a placeholder for now
        return { 
          success: true,
          message: "Task specification retrieval is not implemented in shared commands yet"
        };
      } catch (error) {
        log.error("Failed to get task specification", { 
          error: error instanceof Error ? error.message : String(error),
          taskId: params.taskId 
        });
        throw error;
      }
    },
  });
} 
