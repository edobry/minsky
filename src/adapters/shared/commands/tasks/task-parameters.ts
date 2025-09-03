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
  specPath: {
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
  // Optional time window filters for list/get style commands
  since: {
    schema: z.string(),
    description: "Only include tasks updated on/after this time (YYYY-MM-DD or 7d/24h/30m)",
    required: false,
  },
  until: {
    schema: z.string(),
    description: "Only include tasks updated on/before this time (YYYY-MM-DD or 7d/24h/30m)",
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
 * Task deletion parameters (using shared parameters)
 */
export const taskDeletionParams = {
  force: CommonParameters.force,
};

/**
 * Task editing parameters
 */
export const taskEditParams = {
  title: {
    schema: z.string(),
    description: "New title for the task",
    required: false,
  },
  spec: {
    schema: z.boolean().default(false),
    description: "Edit task specification content (opens editor or reads from stdin)",
    required: false,
  },
  specFile: {
    schema: z.string(),
    description: "Path to file containing new task specification content",
    required: false,
  },
  specContent: {
    schema: z.string(),
    description: "New specification content (completely replaces existing)",
    required: false,
  },
  force: {
    schema: z.boolean().default(false),
    description: "Skip confirmation prompts",
    required: false,
  },
};

/**
 * Index embeddings parameters
 */
export const tasksIndexEmbeddingsParams: CommandParameterMap = {
  // Optional single-task target (CLI should use --task, not --task-id)
  task: CommonParameters.task,
  reindex: {
    schema: z.boolean().default(false),
    description: "Force re-embedding even if up-to-date",
    required: false,
  },
  concurrency: {
    schema: z.number().int().positive().default(4),
    description: "Number of tasks to index in parallel",
    required: false,
  },
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
  details: {
    schema: z.boolean().default(false),
    description: "Show detailed output including scores and diagnostics",
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
  details: {
    schema: z.boolean().default(false),
    description: "Show human-friendly diagnostic details (embedding model, length, ANN rows)",
    required: false,
  },
  // Add filtering options consistent with tasks list
  all: TaskParameters.all,
  status: TaskParameters.status,
  // Support suppressing progress output
  quiet: CommonParameters.quiet,
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
 * Parameters for tasks edit command
 */
export const tasksEditParams: CommandParameterMap = {
  ...taskIdParam,
  ...taskEditParams,
  ...taskContextParams,
  ...outputFormatParams,
};

/**
 * Parameters for tasks migrate command (md#429 importer by default)
 */
export const tasksMigrateParams: CommandParameterMap = {
  execute: {
    schema: z.boolean().default(false),
    description: "Apply changes (defaults to dry-run without this flag)",
    required: false,
  },
  limit: {
    schema: z.number().int().positive().optional(),
    description: "Limit number of tasks to import",
    required: false,
  },
  filterStatus: {
    schema: z.string().optional(),
    description: "Filter tasks by status (e.g., TODO, IN-PROGRESS)",
    required: false,
  },
  quiet: CommonParameters.quiet,
  ...taskContextParams,
  ...outputFormatParams,
};
