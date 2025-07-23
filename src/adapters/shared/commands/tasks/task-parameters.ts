/**
 * Task Command Parameters
 *
 * Consolidated parameter definitions for all task commands.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { z } from "zod";
import { type CommandParameterMap } from "../../command-registry";
import { TASK_STATUS } from "../../../../domain/tasks/taskConstants";

/**
 * Common task identification parameters
 */
export const taskIdParam = {
  taskId: {
    schema: z.string(),
    description: "Task identifier",
    required: true,
  },
};

/**
 * Common backend/context parameters
 */
export const taskContextParams = {
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
};

/**
 * Common output format parameters
 */
export const outputFormatParams = {
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Task status parameter with validation
 */
export const taskStatusParam = {
  status: {
    schema: z.enum([
      TASK_STATUS.TODO,
      TASK_STATUS.IN_PROGRESS,
      TASK_STATUS.IN_REVIEW,
      TASK_STATUS.DONE,
      TASK_STATUS.BLOCKED,
      TASK_STATUS.CLOSED,
    ]),
    description: "Task status",
    required: false,
  },
};

/**
 * Task creation parameters
 */
export const taskCreationParams = {
  title: {
    schema: z.string(),
    description: "Task title",
    required: true,
  },
  description: {
    schema: z.string(),
    description: "Task description",
    required: false,
  },
  descriptionPath: {
    schema: z.string(),
    description: "Path to file containing task description",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force creation without confirmation",
    required: false,
  },
};

/**
 * Task filtering parameters
 */
export const taskFilterParams = {
  all: {
    schema: z.boolean().default(false),
    description: "Show all tasks including completed",
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
    description: "Filter by task status",
    required: false,
  },
  filter: {
    schema: z.string(),
    description: "Filter tasks by text",
    required: false,
  },
  limit: {
    schema: z.number(),
    description: "Maximum number of tasks to return",
    required: false,
  },
};

/**
 * Task specification parameters
 */
export const taskSpecParams = {
  section: {
    schema: z.string(),
    description: "Specific section of the specification to retrieve",
    required: false,
  },
};

/**
 * Task deletion parameters
 */
export const taskDeletionParams = {
  force: {
    schema: z.boolean().default(false),
    description: "Force deletion without confirmation",
    required: false,
  },
};

// Combined parameter sets for each command

/**
 * Parameters for tasks status get command
 */
export const tasksStatusGetParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks status set command
 */
export const tasksStatusSetParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskStatusParam,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks spec command
 */
export const tasksSpecParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskSpecParams,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks list command
 */
export const tasksListParams: CommandParameterMap = {
  ...taskFilterParams,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks get command
 */
export const tasksGetParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks create command
 */
export const tasksCreateParams: CommandParameterMap = {
  ...taskCreationParams,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks delete command
 */
export const tasksDeleteParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskDeletionParams,
  ...taskContextParams,
  ...outputFormatParams,
};
