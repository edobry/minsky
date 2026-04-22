import { z } from "zod";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";

// Reusable task-id schema: must be a non-empty qualified id (e.g. mt#123).
// This rejects empty strings at the MCP boundary before any DB query is issued.
const taskIdSchema = z
  .string()
  .min(1, "Task ID must not be empty")
  .regex(/^[a-z]+#.+$/, "Task ID must be a qualified id like mt#123, md#456, gh#789");

// Parameter definitions matching the CommandParameterMap interface
const tasksDepsAddParams = {
  task: {
    schema: taskIdSchema,
    description: "Task that will depend on another task (e.g. mt#123)",
    required: true,
  },
  dependsOn: {
    schema: taskIdSchema,
    description: "Task that is the dependency (e.g. mt#456)",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsRmParams = {
  task: {
    schema: taskIdSchema,
    description: "Task that depends on another task (e.g. mt#123)",
    required: true,
  },
  dependsOn: {
    schema: taskIdSchema,
    description: "Task that is the dependency (e.g. mt#456)",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsListParams = {
  task: {
    schema: taskIdSchema,
    description: "ID of the task to list dependencies for (e.g. mt#123)",
    required: true,
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
      const service = getTaskGraphService();
      const result = await service.addDependency(params.task, params.dependsOn);

      const output = result.created
        ? `✅ Added dependency: ${params.task} depends on ${params.dependsOn}`
        : `ℹ️  Dependency already exists: ${params.task} depends on ${params.dependsOn}`;

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
      const service = getTaskGraphService();
      const result = await service.removeDependency(params.task, params.dependsOn);

      const output = result.removed
        ? `✅ Removed dependency: ${params.task} no longer depends on ${params.dependsOn}`
        : `ℹ️  Dependency did not exist: ${params.task} was not depending on ${params.dependsOn}`;

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
      const service = getTaskGraphService();
      const dependencies = await service.listDependencies(params.task);
      const dependents = await service.listDependents(params.task);

      const lines: string[] = [];

      // Use concise format by default
      if (params.verbose) {
        // Original verbose format for users who prefer it
        lines.push(`📋 Dependencies for ${params.task}`);
        lines.push(`━`.repeat(40));

        if (dependencies.length > 0) {
          lines.push(`\n⬅️  Dependencies (${params.task} depends on):`);
          dependencies.forEach((dep) => {
            lines.push(`   • ${dep}`);
          });
        }

        if (dependents.length > 0) {
          lines.push(`\n➡️  Dependents (tasks that depend on ${params.task}):`);
          dependents.forEach((dep) => {
            lines.push(`   • ${dep}`);
          });
        }

        if (dependencies.length === 0 && dependents.length === 0) {
          lines.push(`\n🔍 No dependencies or dependents found`);
        }
      } else {
        // New concise format
        lines.push(`${params.task}:`);

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

const tasksChildrenParams = {
  task: {
    schema: taskIdSchema,
    description: "ID of the parent task to list children for (e.g. mt#123)",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksParentParams = {
  task: {
    schema: taskIdSchema,
    description: "ID of the task to find parent of (e.g. mt#123)",
    required: true,
  },
} satisfies CommandParameterMap;

export function createTasksChildrenCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.children",
    name: "children",
    description: "List subtasks (children) of a parent task",
    parameters: tasksChildrenParams,
    execute: async (params: InferParams<typeof tasksChildrenParams>) => {
      const service = getTaskGraphService();
      const children = await service.listChildren(params.task);

      if (children.length === 0) {
        return { success: true, output: `${params.task}: no subtasks` };
      }

      const lines = [`${params.task}: ${children.length} subtask(s)`];
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
      const service = getTaskGraphService();
      const parent = await service.getParent(params.task);

      if (parent === null) {
        return { success: true, output: `${params.task}: no parent (root task)` };
      }

      return { success: true, output: `${params.task}: parent is ${parent}` };
    },
  };
}
