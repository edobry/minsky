import type { CommandMapper } from "../../mcp/command-mapper";
import { z } from "zod";
import { PersistenceService } from "../../domain/persistence/service";
import { TaskGraphService } from "../../domain/tasks/task-graph-service";

const AddSchema = z.object({ fromTaskId: z.string(), toTaskId: z.string() });
const RemoveSchema = z.object({ fromTaskId: z.string(), toTaskId: z.string() });
const ListSchema = z.object({
  taskId: z.string(),
  direction: z.enum(["deps", "dependents"]).default("deps"),
});

export function registerTaskRelationshipTools(commandMapper: CommandMapper): void {
  commandMapper.addCommand({
    name: "tasks.relationships.add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: AddSchema,
    handler: async (args) => {
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection();
      const service = new TaskGraphService(db);
      const result = await service.addDependency(args.fromTaskId, args.toTaskId);
      return { success: true, created: result.created };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.remove",
    description: "Remove a dependency edge",
    parameters: RemoveSchema,
    handler: async (args) => {
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection();
      const service = new TaskGraphService(db);
      const result = await service.removeDependency(args.fromTaskId, args.toTaskId);
      return { success: true, removed: result.removed };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.list",
    description: "List dependencies or dependents for a task",
    parameters: ListSchema,
    handler: async (args) => {
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection();
      const service = new TaskGraphService(db);
      if (args.direction === "dependents") {
        const list = await service.listDependents(args.taskId);
        return { success: true, items: list };
      }
      const list = await service.listDependencies(args.taskId);
      return { success: true, items: list };
    },
  });
}
