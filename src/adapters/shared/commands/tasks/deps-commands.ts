import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DatabaseConnectionManager } from "../../../../domain/database/connection-manager";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type CommandParameterMap } from "../../command-registry";

// Parameter definitions matching the CommandParameterMap interface
const tasksDepsAddParams: CommandParameterMap = {
  task: {
    schema: z.string(),
    description: "Task that will depend on another task",
    required: true,
  },
  dependsOn: {
    schema: z.union([z.string(), z.array(z.string())]),
    description: "Task that is the dependency, or comma-separated list of task IDs",
    required: true,
  },
};

const tasksDepsRmParams: CommandParameterMap = {
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
};

const tasksDepsListParams: CommandParameterMap = {
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
};

export function createTasksDepsAddCommand() {
  return {
    id: "tasks.deps.add",
    name: "add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: tasksDepsAddParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await new DatabaseConnectionManager().getConnection();
      const service = new TaskGraphService(db);

      // Parse dependencies (handle both string and array formats)
      const dependencies = Array.isArray(params.dependsOn)
        ? params.dependsOn
        : typeof params.dependsOn === "string"
          ? params.dependsOn.split(",").map((d) => d.trim())
          : [params.dependsOn];

      const results: string[] = [];
      let allSuccessful = true;

      for (const dep of dependencies) {
        try {
          // Just use the dependency task ID directly - no type parsing needed
          const depTaskId = dep.trim();

          const result = await service.addDependency(params.task, depTaskId);

          if (result.created) {
            results.push(`✅ Added dependency: ${params.task} depends on ${depTaskId}`);
          } else {
            results.push(`ℹ️  Dependency already exists: ${params.task} depends on ${depTaskId}`);
          }
        } catch (error) {
          results.push(`❌ Failed to add dependency ${dep}: ${error.message}`);
          allSuccessful = false;
        }
      }

      const output = results.join("\n");
      return { success: allSuccessful, output };
    },
  };
}

export function createTasksDepsRmCommand() {
  return {
    id: "tasks.deps.rm",
    name: "rm",
    description: "Remove a dependency edge",
    parameters: tasksDepsRmParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await new DatabaseConnectionManager().getConnection();
      const service = new TaskGraphService(db);
      const result = await service.removeDependency(params.task, params.dependsOn);

      const output = result.removed
        ? `✅ Removed dependency: ${params.task} no longer depends on ${params.dependsOn}`
        : `ℹ️  Dependency did not exist: ${params.task} was not depending on ${params.dependsOn}`;

      return { success: true, output };
    },
  };
}

export function createTasksDepsListCommand() {
  return {
    id: "tasks.deps.list",
    name: "list",
    description: "List dependencies for a task",
    parameters: tasksDepsListParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await new DatabaseConnectionManager().getConnection();
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