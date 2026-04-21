/**
 * Task Context Commands (decompose, estimate, analyze)
 *
 * Context-gathering MCP tools for AI-assisted task management.
 * Each command gathers structured context and generates a prompt
 * pairing context with intent. Works in both agent-present and
 * standalone-future contexts.
 */
import { z } from "zod";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import {
  type TaskContext,
  type TaskPromptType,
  generateDecomposePrompt,
  generateEstimatePrompt,
  generateAnalyzePrompt,
} from "../../../../domain/tasks/task-prompt-generation";
import { log } from "../../../../utils/logger";

const taskContextParams = {
  taskId: {
    schema: z.string(),
    description: "Task ID to gather context for",
    required: true,
  },
  similarLimit: {
    schema: z.number().default(5),
    description: "Maximum number of similar tasks to include",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Gather full context for a task: spec, children, deps, similar tasks.
 * Shared by all context commands.
 */
async function gatherTaskContext(
  taskId: string,
  _similarLimit: number,
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
): Promise<TaskContext> {
  const taskService = getTaskService();

  const task = await taskService.getTask(taskId);
  const title = task?.title ?? "(unknown)";
  const status = task?.status ?? "UNKNOWN";

  // Get spec
  let spec: string | undefined;
  try {
    const { getTaskSpecContentFromParams } = await import(
      "../../../../domain/tasks/commands/query-commands"
    );
    const specResult = await getTaskSpecContentFromParams({
      taskId,
      workspace: process.cwd(),
    });
    spec = specResult.content;
  } catch {
    // Spec not available
  }

  // Get graph info (children, deps, parent) via injected graph service
  const children: TaskContext["children"] = [];
  let dependencies: string[] = [];
  let dependents: string[] = [];
  let parent: string | undefined;

  try {
    const service = getTaskGraphService();

    // Children
    const childIds = await service.listChildren(taskId);
    for (const childId of childIds) {
      try {
        const childTask = await taskService.getTask(childId);
        children.push({
          id: childId,
          title: childTask?.title ?? "(unknown)",
          status: childTask?.status ?? "UNKNOWN",
        });
      } catch {
        children.push({ id: childId, title: "(unknown)", status: "UNKNOWN" });
      }
    }

    // Dependencies and dependents
    dependencies = await service.listDependencies(taskId);
    dependents = await service.listDependents(taskId);

    // Parent
    parent = (await service.getParent(taskId)) ?? undefined;
  } catch {
    // Graph service unavailable — return context without graph info
  }

  // Similar tasks — skipped in context gathering (requires DI-wired
  // TaskSimilarityService). The generated prompt directs the agent to
  // call tasks_similar separately if needed.
  const similarTasks: TaskContext["similarTasks"] = [];

  return {
    taskId,
    title,
    status,
    spec,
    children,
    dependencies,
    dependents,
    parent,
    similarTasks,
  };
}

function createContextCommand(
  type: TaskPromptType,
  description: string,
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return {
    id: `tasks.${type}`,
    name: type,
    description,
    parameters: taskContextParams,
    execute: async (params: InferParams<typeof taskContextParams>) => {
      const taskId = params.taskId as string;
      const similarLimit = (params.similarLimit as number) ?? 5;

      log.debug(`[tasks.${type}] Gathering context`, { taskId });

      const context = await gatherTaskContext(
        taskId,
        similarLimit,
        getTaskGraphService,
        getTaskService
      );

      const generators = {
        decompose: generateDecomposePrompt,
        estimate: generateEstimatePrompt,
        analyze: generateAnalyzePrompt,
      };

      const result = generators[type](context);

      log.debug(`[tasks.${type}] Prompt generated`, {
        taskId,
        promptLength: result.prompt.length,
        childrenCount: context.children.length,
        similarCount: context.similarTasks.length,
      });

      return {
        success: true,
        ...result,
      };
    },
  };
}

export function createTasksDecomposeCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return createContextCommand(
    "decompose",
    "Gather task context and generate a decomposition prompt for creating subtasks",
    getTaskGraphService,
    getTaskService
  );
}

export function createTasksEstimateCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return createContextCommand(
    "estimate",
    "Gather task context and generate an estimation prompt for complexity/effort",
    getTaskGraphService,
    getTaskService
  );
}

export function createTasksAnalyzeCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return createContextCommand(
    "analyze",
    "Gather task context and generate an analysis prompt for spec completeness and readiness",
    getTaskGraphService,
    getTaskService
  );
}
