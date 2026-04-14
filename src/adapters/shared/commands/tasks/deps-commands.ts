import { z } from "zod";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "../../../../domain/persistence/types";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";

// Parameter definitions matching the CommandParameterMap interface
const tasksDepsAddParams = {
  task: {
    schema: z.string(),
    description: "Task that will depend on another task",
    required: true,
  },
  dependsOn: {
    schema: z.string(),
    description: "Task that is the dependency",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsRmParams = {
  task: {
    schema: z.string(),
    description: "Task that depends on another task",
    required: true,
  },
  dependsOn: {
    schema: z.string(),
    description: "Task that is the dependency",
    required: true,
  },
} satisfies CommandParameterMap;

const tasksDepsListParams = {
  task: {
    schema: z.string(),
    description: "ID of the task to list dependencies for",
    required: true,
  },
  verbose: {
    schema: z.boolean().optional(),
    description: "Use more detailed output format",
    required: false,
  },
} satisfies CommandParameterMap;

export function createTasksDepsAddCommand(getPersistenceProvider: () => PersistenceProvider) {
  return {
    id: "tasks.deps.add",
    name: "add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: tasksDepsAddParams,
    execute: async (params: InferParams<typeof tasksDepsAddParams>) => {
      const persistence = getPersistenceProvider() as SqlCapablePersistenceProvider;
      const db = await persistence.getDatabaseConnection();
      if (!db) throw new Error("Database connection not available");
      const service = new TaskGraphService(db);
      const result = await service.addDependency(params.task, params.dependsOn);

      const output = result.created
        ? `✅ Added dependency: ${params.task} depends on ${params.dependsOn}`
        : `ℹ️  Dependency already exists: ${params.task} depends on ${params.dependsOn}`;

      return { success: true, output };
    },
  };
}

export function createTasksDepsRmCommand(getPersistenceProvider: () => PersistenceProvider) {
  return {
    id: "tasks.deps.rm",
    name: "rm",
    description: "Remove a dependency edge",
    parameters: tasksDepsRmParams,
    execute: async (params: InferParams<typeof tasksDepsRmParams>) => {
      const persistence = getPersistenceProvider() as SqlCapablePersistenceProvider;
      const db = await persistence.getDatabaseConnection();
      if (!db) throw new Error("Database connection not available");
      const service = new TaskGraphService(db);
      const result = await service.removeDependency(params.task, params.dependsOn);

      const output = result.removed
        ? `✅ Removed dependency: ${params.task} no longer depends on ${params.dependsOn}`
        : `ℹ️  Dependency did not exist: ${params.task} was not depending on ${params.dependsOn}`;

      return { success: true, output };
    },
  };
}

export function createTasksDepsListCommand(getPersistenceProvider: () => PersistenceProvider) {
  return {
    id: "tasks.deps.list",
    name: "list",
    description: "List dependencies for a task",
    parameters: tasksDepsListParams,
    execute: async (params: InferParams<typeof tasksDepsListParams>) => {
      const persistence = getPersistenceProvider() as SqlCapablePersistenceProvider;
      const db = await persistence.getDatabaseConnection();
      if (!db) throw new Error("Database connection not available");
      const service = new TaskGraphService(db);
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
