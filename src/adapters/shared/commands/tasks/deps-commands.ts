import { z } from "zod";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import { ValidationError } from "@minsky/domain/errors/index";

// Parameter definitions matching the CommandParameterMap interface.
// mt#2741: canonical task-id param is `taskId` (tasks_* family convention); `task`
// is kept as a permanent back-compat alias (see resolveTaskId + the mt#2737 note
// below). Both optional at the schema layer; resolveTaskId requires at least one.
const tasksDepsAddParams = {
  taskId: {
    schema: z.string().optional(),
    description: "The dependent task (the task that will depend on another)",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
  dependsOn: {
    schema: z.string(),
    description: "Task that is the dependency",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsRmParams = {
  taskId: {
    schema: z.string().optional(),
    description: "The dependent task (the task that depends on another)",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
  dependsOn: {
    schema: z.string(),
    description: "Task that is the dependency",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsListParams = {
  taskId: {
    schema: z.string().optional(),
    description: "ID of the task to list dependencies for",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
  verbose: {
    schema: z.boolean().optional(),
    description: "Use more detailed output format",
    required: false,
  },
} satisfies CommandParameterMap;

export function createTasksDepsAddCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.deps.add",
    name: "add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: tasksDepsAddParams,
    execute: async (params: InferParams<typeof tasksDepsAddParams>) => {
      const taskId = resolveTaskId(params, "tasks.deps.add");
      const service = getTaskGraphService();
      const result = await service.addDependency(taskId, params.dependsOn);

      const output = result.created
        ? `✅ Added dependency: ${taskId} depends on ${params.dependsOn}`
        : `ℹ️  Dependency already exists: ${taskId} depends on ${params.dependsOn}`;

      return { success: true, output };
    },
  };
}

export function createTasksDepsRmCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.deps.rm",
    name: "rm",
    description: "Remove a dependency edge",
    parameters: tasksDepsRmParams,
    execute: async (params: InferParams<typeof tasksDepsRmParams>) => {
      const taskId = resolveTaskId(params, "tasks.deps.rm");
      const service = getTaskGraphService();
      const result = await service.removeDependency(taskId, params.dependsOn);

      const output = result.removed
        ? `✅ Removed dependency: ${taskId} no longer depends on ${params.dependsOn}`
        : `ℹ️  Dependency did not exist: ${taskId} was not depending on ${params.dependsOn}`;

      return { success: true, output };
    },
  };
}

export function createTasksDepsListCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.deps.list",
    name: "list",
    description: "List dependencies for a task",
    parameters: tasksDepsListParams,
    execute: async (params: InferParams<typeof tasksDepsListParams>) => {
      const taskId = resolveTaskId(params, "tasks.deps.list");
      const service = getTaskGraphService();
      const dependencies = await service.listDependencies(taskId);
      const dependents = await service.listDependents(taskId);

      const lines: string[] = [];

      // Use concise format by default
      if (params.verbose) {
        // Original verbose format for users who prefer it
        lines.push(`📋 Dependencies for ${taskId}`);
        lines.push(`━`.repeat(40));

        if (dependencies.length > 0) {
          lines.push(`\n⬅️  Dependencies (${taskId} depends on):`);
          dependencies.forEach((dep) => {
            lines.push(`   • ${dep}`);
          });
        }

        if (dependents.length > 0) {
          lines.push(`\n➡️  Dependents (tasks that depend on ${taskId}):`);
          dependents.forEach((dep) => {
            lines.push(`   • ${dep}`);
          });
        }

        if (dependencies.length === 0 && dependents.length === 0) {
          lines.push(`\n🔍 No dependencies or dependents found`);
        }
      } else {
        // New concise format
        lines.push(`${taskId}:`);

        if (dependencies.length > 0) {
          const depList = dependencies.join(", ");
          lines.push(`  depends on: ${depList}`);
        }

        if (dependents.length > 0) {
          const depList = dependents.join(", ");
          lines.push(`  required by: ${depList}`);
        }

        if (dependencies.length === 0 && dependents.length === 0) {
          lines.push(`  no dependencies`);
        }
      }

      return { success: true, output: lines.join("\n") };
    },
  };
}

// mt#2737: canonical param is `taskId`, matching the tasks_* family convention
// (tasks_get / tasks_status_get / tasks_spec_get all use `taskId`). Originally
// these two commands used `task`; callers following the family convention passed
// `taskId`, which arrived undefined and ran the relationship query with an
// undefined bind (UNDEFINED_VALUE). `task` is retained as a permanent back-compat
// alias (Postel's law) so pre-existing `task`-name callers don't silently break;
// `taskId` wins when both are supplied. Both are optional at the schema layer and
// `resolveTaskId` requires at least one (preferring `taskId`), throwing otherwise.
const tasksChildrenParams = {
  taskId: {
    schema: z.string().optional(),
    description: "ID of the parent task to list children for",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
} satisfies CommandParameterMap;

const tasksParentParams = {
  taskId: {
    schema: z.string().optional(),
    description: "ID of the task to find parent of",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Resolve the task id from the canonical `taskId` param or the legacy `task`
 * alias (mt#2737). Throws when neither is supplied so the caller gets a clear
 * validation error instead of an undefined DB bind (the original bug). Exported
 * (mt#2741) for reuse by the sibling deps-visualization commands.
 */
export function resolveTaskId(
  params: { taskId?: string; task?: string },
  commandName: string
): string {
  const taskId = params.taskId ?? params.task;
  if (!taskId) {
    throw new ValidationError(
      `${commandName} requires 'taskId' ('task' is accepted as a legacy alias)`
    );
  }
  return taskId;
}

export function createTasksChildrenCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.children",
    name: "children",
    description: "List subtasks (children) of a parent task",
    parameters: tasksChildrenParams,
    execute: async (params: InferParams<typeof tasksChildrenParams>) => {
      const taskId = resolveTaskId(params, "tasks.children");
      const service = getTaskGraphService();
      const children = await service.listChildren(taskId);

      if (children.length === 0) {
        return { success: true, output: `${taskId}: no subtasks` };
      }

      const lines = [`${taskId}: ${children.length} subtask(s)`];
      for (const child of children) {
        lines.push(`  ${child}`);
      }
      return { success: true, output: lines.join("\n") };
    },
  };
}

export function createTasksParentCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.parent",
    name: "parent",
    description: "Show the parent task of a subtask",
    parameters: tasksParentParams,
    execute: async (params: InferParams<typeof tasksParentParams>) => {
      const taskId = resolveTaskId(params, "tasks.parent");
      const service = getTaskGraphService();
      const parent = await service.getParent(taskId);

      if (parent === null) {
        return { success: true, output: `${taskId}: no parent (root task)` };
      }

      return { success: true, output: `${taskId}: parent is ${parent}` };
    },
  };
}
