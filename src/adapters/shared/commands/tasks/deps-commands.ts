import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DatabaseConnectionManager } from "../../../domain/database/connection-manager";
import { TaskGraphService } from "../../../domain/tasks/task-graph-service";

const AddParams = z.object({ task: z.string(), dependsOn: z.string() });
const RmParams = z.object({ task: z.string(), dependsOn: z.string() });
const ListParams = z.object({ task: z.string() });

export function createTasksDepsAddCommand() {
  return {
    id: "tasks.deps.add",
    name: "deps add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: AddParams,
    execute: async (params: z.infer<typeof AddParams>) => {
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
    name: "deps rm",
    description: "Remove a dependency edge",
    parameters: RmParams,
    execute: async (params: z.infer<typeof RmParams>) => {
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
    name: "deps list",
    description: "List dependencies for a task",
    parameters: ListParams,
    execute: async (params: z.infer<typeof ListParams>) => {
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
      const service = new TaskGraphService(db);
      const items = await service.listDependencies(params.task);
      return { success: true, items };
    },
  };
}
