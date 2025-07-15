/**
 * Shared Tasks Commands
 *
 * This module contains shared task command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { select, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
  type CommandDefinition,
} from "../command-registry";
import {
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  getTaskSpecContentFromParams,
  normalizeTaskId,
  listTasksFromParams,
  getTaskFromParams,
  createTaskFromParams,
  createTaskFromTitleAndDescription,
  deleteTaskFromParams,
} from "../../../domain/tasks";
import { TaskService } from "../../../domain/tasks/taskService";
import { log } from "../../../utils/logger";
import { ValidationError } from "../../../errors/index";
// Import task status constants from centralized location
import { TASK_STATUS } from "../../../domain/tasks/taskConstants";
// Schemas removed as they are unused in this file

/**
 * Parameters for tasks status get command
 */
const tasksStatusGetParams = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
} as const satisfies CommandParameterMap;

/**
 * Type for tasks status get parameters
 */
type TasksStatusGetParams = {
  taskId: string;
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
  json?: boolean;
};

/**
 * Parameters for tasks status set command
 */
const tasksStatusSetParams = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  status: {
    schema: z.enum(["NEW", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"]),
    description: "Task status",
    required: true,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session name",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
} as const satisfies CommandParameterMap;

/**
 * Type for tasks status set parameters
 */
type TasksStatusSetParams = {
  taskId: string;
  status: "NEW" | "IN_PROGRESS" | "BLOCKED" | "IN_REVIEW" | "DONE" | "CANCELLED";
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
  json?: boolean;
};

/**
 * Parameters for tasks spec command
 */
const tasksSpecParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
  section: {
    schema: z.string(),
    description: "Specific section of the specification to retrieve",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Backend identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Type for tasks spec parameters
 */
type TasksSpecParams = {
  taskId: string;
  section?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  backend?: string;
  json?: boolean;
};

/**
 * Task status get command definition
 */
const tasksStatusGetRegistration = {
  id: "tasks.status.get",
  category: CommandCategory.TASKS,
  name: "status get",
  description: "Get the status of a task",
  parameters: tasksStatusGetParams,
  execute: async (params: TasksStatusGetParams, ctx: CommandExecutionContext) => {
    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }
    const status = await getTaskStatusFromParams({
      ...params,
      taskId: normalizedTaskId,
    });
    return {
      success: true,
      taskId: normalizedTaskId,
      status: status,
    };
  },
};

/**
 * Task status set command definition
 */
const tasksStatusSetRegistration = {
  id: "tasks.status.set",
  category: CommandCategory.TASKS,
  name: "status set",
  description: "Set the status of a task",
  parameters: tasksStatusSetParams,
  execute: async (params: TasksStatusSetParams, _ctx: CommandExecutionContext) => {
    log.debug("Starting tasks.status.set execution");
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");

    const normalizedTaskId = normalizeTaskId(params.taskId);
    if (!normalizedTaskId) {
      throw new ValidationError(
        `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
      );
    }

    const setTaskStatusParams = {
      taskId: normalizedTaskId,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
      backend: params.backend,
    };

    const status = params.status;

    // Validate status is one of the supported values
    const validStatuses = ["NEW", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      throw new ValidationError(
        `Invalid status: '${status}'. Must be one of: ${validStatuses.join(", ")}`
      );
    }

    await setTaskStatusFromParams({
      ...setTaskStatusParams,
      status,
    });

    return {
      success: true,
      taskId: normalizedTaskId,
      status: status,
    };
  },
};

/**
 * Task spec command definition
 */
const tasksSpecRegistration = {
  id: "tasks.spec",
  category: CommandCategory.TASKS,
  name: "spec",
  description: "Get task specification content",
  parameters: tasksSpecParams,
  execute: async (params: TasksSpecParams, ctx: CommandExecutionContext) => {
    try {
      const normalizedTaskId = normalizeTaskId(params.taskId);
      if (!normalizedTaskId) {
        throw new ValidationError(
          `Invalid task ID: '${params.taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
        );
      }
      const result = await getTaskSpecContentFromParams({
        ...params,
        taskId: normalizedTaskId,
      });
      return result;
    } catch (error) {
      log.error("Error getting task specification", { error });
      throw error;
    }
  },
};

/**
 * Parameters for tasks list command
 */
const tasksListParams: CommandParameterMap = {
  filter: {
    schema: z.string(),
    description: "Filter tasks by status or other criteria",
    required: false,
  },
  status: {
    schema: z.enum([
      TASK_STATUS.TODO,
      TASK_STATUS.IN_PROGRESS,
      TASK_STATUS.IN_REVIEW,
      TASK_STATUS.DONE,
      TASK_STATUS.BLOCKED,
      TASK_STATUS.CLOSED,
    ]),
    description: "Filter tasks by status",
    required: false,
  },
  limit: {
    schema: z.number(),
    description: "Limit the number of tasks returned",
    required: false,
  },
  all: {
    schema: z.boolean().default(false),
    description: "Include completed tasks",
    required: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Parameters for tasks get command
 */
const tasksGetParams: CommandParameterMap = {
  taskId: {
    schema: z.string(),
    description: "ID of the task to retrieve",
    required: true,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Type for tasks get parameters
 */
type TasksGetParams = {
  taskId: string;
  backend?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  json?: boolean;
};

/**
 * Parameters for tasks create command
 */
const tasksCreateParams: CommandParameterMap = {
  title: {
    schema: z.string().min(1),
    description: "Title for the task",
    required: true,
  },
  description: {
    schema: z.string(),
    description: "Description text for the task",
    required: false,
  },
  descriptionPath: {
    schema: z.string(),
    description: "Path to file containing task description",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force creation even if task already exists",
    required: false,
    defaultValue: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Type for tasks create parameters
 */
type TasksCreateParams = {
  title: string;
  description?: string;
  descriptionPath?: string;
  force?: boolean;
  backend?: string;
  repo?: string;
  workspace?: string;
  session?: string;
  json?: boolean;
};

/**
 * Tasks commands registration parameters and definitions
 */
const tasksListRegistration = {
  id: "tasks.list",
  category: CommandCategory.TASKS,
  name: "list",
  description: "List tasks with optional filtering",
  parameters: tasksListParams,
  execute: async (params, ctx) => {
    const { all = false, status, filter, ...rest } = params;

    // Use status parameter if provided, otherwise fall back to filter
    const filterParam = status || filter;

    return await listTasksFromParams({
      all,
      filter: filterParam,
      ...rest,
    });
  },
};

/**
 * Register tasks.get command
 */
const tasksGetRegistration = {
  id: "tasks.get",
  category: CommandCategory.TASKS,
  name: "get",
  description: "Get a task by ID",
  parameters: tasksGetParams,
  execute: async (params: TasksGetParams, ctx: CommandExecutionContext) => {
    if (!params.taskId) throw new ValidationError("Missing required parameter: taskId");
    return await getTaskFromParams({
      taskId: params.taskId,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });
  },
};

/**
 * Register tasks.create command
 */
const tasksCreateRegistration = {
  id: "tasks.create",
  category: CommandCategory.TASKS,
  name: "create",
  description: "Create a new task with --title and --description",
  parameters: tasksCreateParams,
  execute: async (params: TasksCreateParams, ctx: CommandExecutionContext) => {
    // Title is required by schema, but validate it's provided
    if (!params.title) {
      throw new ValidationError("Title is required");
    }

    // Validate that either description or descriptionPath is provided
    if (!params.description && !params.descriptionPath) {
      throw new ValidationError("Either --description or --description-path must be provided");
    }

    // Both description and descriptionPath provided is an error
    if (params.description && params.descriptionPath) {
      throw new ValidationError(
        "Cannot provide both --description and --description-path - use one or the other"
      );
    }

    return await createTaskFromTitleAndDescription({
      title: params.title,
      description: params.description,
      descriptionPath: params.descriptionPath,
      force: params.force ?? false,
      backend: params.backend,
      repo: params.repo,
      workspace: params.workspace,
      session: params.session,
    });
  },
};

/**
 * Parameters for tasks delete command
 */
const tasksDeleteParams: CommandParameterMap = {
  taskId: {
    schema: z.string().min(1),
    description: "ID of the task to delete",
    required: true,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force deletion without confirmation",
    required: false,
    defaultValue: false,
  },
  backend: {
    schema: z.string(),
    description: "Specify task backend (markdown, json-file, github)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  workspace: {
    schema: z.string(),
    description: "Workspace path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Session identifier",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Register tasks.delete command
 */
const tasksDeleteRegistration = {
  id: "tasks.delete",
  category: CommandCategory.TASKS,
  name: "delete",
  description: "Delete a task",
  parameters: tasksDeleteParams,
  execute: async (params, ctx) => {
    if (!(params as unknown)!.taskId) throw new ValidationError("Missing required parameter: taskId");

    // Handle confirmation if force is not set and we're in interactive mode
    if (!(params as unknown)!.force && !(params as unknown)!.json) {
      // Get task details for confirmation
      const task = await getTaskFromParams({
        taskId: (params as unknown)!.taskId,
        backend: (params as unknown)!.backend,
        repo: (params as unknown)!.repo,
        workspace: (params as unknown)!.workspace,
        session: (params as unknown)!.session,
      });

      // Import confirm from @clack/prompts for confirmation
      const { confirm, isCancel } = await import("@clack/prompts");

      const shouldDelete = await confirm({
        message: `Are you sure you want to delete task ${(task as unknown)!.id}: "${(task as unknown)!.title}"?`,
      });

      if (isCancel(shouldDelete) || !shouldDelete) {
        return {
          success: false,
          message: "Task deletion cancelled",
          taskId: (params as unknown)!.taskId,
        };
      }
    }

    const result = await deleteTaskFromParams({
      taskId: (params as unknown)!.taskId,
      force: (params as unknown)!.force ?? false,
      backend: (params as unknown)!.backend,
      repo: (params as unknown)!.repo,
      workspace: (params as unknown)!.workspace,
      session: (params as unknown)!.session,
    }) as unknown;

    const message = (result as unknown)!.success
      ? `Task ${(result as unknown)!.taskId} deleted successfully`
      : `Failed to delete task ${(result as unknown)!.taskId}`;

    // Return different formats based on --json flag
    if ((params as unknown)!.json) {
      // Structured output for programmatic use
      return {
        success: (result as unknown)!.success,
        taskId: (result as unknown)!.taskId,
        task: (result as unknown)!.task,
        message: message,
      } as unknown;
    } else {
      // Simple message for user-friendly output
      return message;
    }
  },
};

export function registerTasksCommands() {
  // Register tasks.list command
  sharedCommandRegistry.registerCommand(tasksListRegistration);

  // Register tasks.get command
  sharedCommandRegistry.registerCommand(tasksGetRegistration);

  // Register tasks.create command
  sharedCommandRegistry.registerCommand(tasksCreateRegistration);

  // Register tasks.delete command
  sharedCommandRegistry.registerCommand(tasksDeleteRegistration);

  // Register tasks.status.get command
  sharedCommandRegistry.registerCommand(tasksStatusGetRegistration);

  // Register tasks.status.set command
  sharedCommandRegistry.registerCommand(tasksStatusSetRegistration);

  // Register tasks.spec command
  sharedCommandRegistry.registerCommand(tasksSpecRegistration);
}
