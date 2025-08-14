/**
 * Task Command Parameters
 *
 * Consolidated parameter definitions for all task commands.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { z } from "zod";
import { type CommandParameterMap } from "../../command-registry";
import { TASK_STATUS } from "../../../../domain/tasks/taskConstants";
import { CommonParameters, TaskParameters, composeParams } from "../../common-parameters";

/**
 * Common task identification parameters (using shared parameters)
 */
export const taskIdParam = {
  taskId: TaskParameters.taskId,
};

/**
 * Common backend/context parameters (using shared parameters)
 */
export const taskContextParams = {
  repo: CommonParameters.repo,
  workspace: CommonParameters.workspace,
  session: CommonParameters.session,
  backend: CommonParameters.backend,
};

/**
 * Common output format parameters (using shared parameters)
 */
export const outputFormatParams = {
  json: CommonParameters.json,
};

/**
 * Task status parameter with validation (using shared parameters)
 */
export const taskStatusParam = {
  status: TaskParameters.status,
};

/**
 * Task creation parameters (using shared parameters)
 */
export const taskCreationParams = {
  title: TaskParameters.title,
  description: TaskParameters.description,
  force: CommonParameters.force,
  descriptionPath: {
    schema: z.string(),
    description: "Path to file containing task description",
    required: false,
  },
  githubRepo: {
    schema: z.string(),
    description:
      "GitHub repository override in 'owner/repo' format (only for github-issues backend)",
    required: false,
  },
};

/**
 * Task filtering parameters (using shared parameters)
 */
export const taskFilterParams = {
  all: TaskParameters.all,
  status: TaskParameters.status,
  filter: TaskParameters.filter,
  limit: TaskParameters.limit,
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
 * Task deletion parameters (using shared parameters)
 */
export const taskDeletionParams = {
  force: CommonParameters.force,
};

/**
 * Index embeddings parameters
 */
export const tasksIndexEmbeddingsParams: CommandParameterMap = {
  limit: {
    schema: z.number().int().positive().default(10),
    description: "Max number of tasks to index (to avoid heavy costs)",
    required: false,
  },
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Similarity parameters (taskId + limit/threshold)
 */
export const tasksSimilarParams: CommandParameterMap = {
  ...taskIdParam,
  limit: {
    schema: z.number().int().positive().default(10),
    description: "Max number of results",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    description: "Optional distance threshold (lower is closer)",
    required: false,
  },
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Search-by-text parameters
 */
export const tasksSearchParams: CommandParameterMap = {
  query: {
    schema: z.string(),
    description: "Natural language query",
    required: true,
  },
  limit: {
    schema: z.number().int().positive().default(10),
    description: "Max number of results",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    description: "Optional distance threshold (lower is closer)",
    required: false,
  },
  ...taskContextParams,
  ...outputFormatParams,
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

/**
 * Task migration specific parameters
 */
export const taskMigrationParams = {
  dryRun: {
    schema: z.boolean().default(false),
    description: "Show what would be changed without making changes",
    required: false,
  },
  toBackend: {
    schema: z.string().default("md"),
    description: "Target backend for migration (e.g., 'md', 'gh')",
    required: false,
  },
  statusFilter: {
    schema: z.string().optional(),
    description: "Filter tasks by status (TODO, IN-PROGRESS, DONE, etc.)",
    required: false,
  },
  createBackup: {
    schema: z.boolean().default(true),
    description: "Create backup before migration",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Force migration even if some tasks might be lost",
    required: false,
  },
  quiet: {
    schema: z.boolean().default(false),
    description: "Suppress non-essential output",
    required: false,
  },
};

/**
 * Parameters for tasks migrate command
 */
export const tasksMigrateParams: CommandParameterMap = {
  ...taskMigrationParams,
  ...taskContextParams,
  ...outputFormatParams,
};
