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

type AddArgs = z.infer<typeof AddSchema>;
type RemoveArgs = z.infer<typeof RemoveSchema>;
type ListArgs = z.infer<typeof ListSchema>;

export function registerTaskRelationshipTools(commandMapper: CommandMapper): void {
  commandMapper.addCommand({
    name: "tasks.relationships.add",
    description: "Add a dependency edge (task depends on prerequisite)",
    parameters: AddSchema,
    handler: async (args) => {
      const typedArgs = args as AddArgs;
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection?.();
      const service = new TaskGraphService(db);
      const result = await service.addDependency(typedArgs.fromTaskId, typedArgs.toTaskId);
      return { success: true, created: result.created };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.remove",
    description: "Remove a dependency edge",
    parameters: RemoveSchema,
    handler: async (args) => {
      const typedArgs = args as RemoveArgs;
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection?.();
      const service = new TaskGraphService(db);
      const result = await service.removeDependency(typedArgs.fromTaskId, typedArgs.toTaskId);
      return { success: true, removed: result.removed };
    },
  });

  commandMapper.addCommand({
    name: "tasks.relationships.list",
    description: "List dependencies or dependents for a task",
    parameters: ListSchema,
    handler: async (args) => {
      const typedArgs = args as ListArgs;
      // PersistenceService should already be initialized at application startup
      const persistence = PersistenceService.getProvider();
      const db = await persistence.getDatabaseConnection?.();
      const service = new TaskGraphService(db);
      if (typedArgs.direction === "dependents") {
        const list = await service.listDependents(typedArgs.taskId);
        return { success: true, items: list };
      }
      const list = await service.listDependencies(typedArgs.taskId);
      return { success: true, items: list };
    },
  });
}
