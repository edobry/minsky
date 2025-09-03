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
    schema: z.string(),
    description: "Task that is the dependency",
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
};

export function createTasksDepsAddCommand() {
  return {
    id: "tasks.deps.add",
    name: "add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: tasksDepsAddParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
      const service = new TaskGraphService(db);
      const result = await service.addDependency(params.task, params.dependsOn);

      const output = result.created
        ? `✅ Added dependency: ${params.task} depends on ${params.dependsOn}`
        : `ℹ️  Dependency already exists: ${params.task} depends on ${params.dependsOn}`;

      return { success: true, output };
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
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
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
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
      const service = new TaskGraphService(db);
      const dependencies = await service.listDependencies(params.task);
      const dependents = await service.listDependents(params.task);

      const lines: string[] = [];
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

      return { success: true, output: lines.join("\n") };
    },
  };
}
