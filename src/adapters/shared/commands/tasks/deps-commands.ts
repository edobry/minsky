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
      return { success: true, created: result.created };
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
      return { success: true, removed: result.removed };
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
      const items = await service.listDependencies(params.task);
      return { success: true, items };
    },
  };
}
