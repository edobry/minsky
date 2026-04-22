import { z } from "zod";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type CommandParameterMap, type InferParams } from "../../command-registry";

const tasksReparentParams = {
  taskId: {
    schema: z.string(),
    description: "ID of the task to reparent (qualified, e.g. mt#123)",
    required: true,
  },
  parent: {
    schema: z.string().nullable(),
    description: "New parent task ID (qualified, e.g. mt#456), or null to orphan the task",
    required: true,
  },
} satisfies CommandParameterMap;

export function createTasksReparentCommand(getTaskGraphService: () => TaskGraphService) {
  return {
    id: "tasks.reparent",
    name: "reparent",
    description: "Move a task to a new parent, or remove its parent (orphan it)",
    parameters: tasksReparentParams,
    execute: async (params: InferParams<typeof tasksReparentParams>) => {
      const service = getTaskGraphService();
      const result = await service.reparent(params.taskId, params.parent);

      let output: string;
      if (result.previousParent === result.newParent) {
        const desc =
          result.newParent === null
            ? `${params.taskId} already has no parent`
            : `${params.taskId} already has parent ${result.newParent}`;
        output = `ℹ️  No-op: ${desc}`;
      } else if (result.newParent === null) {
        output = `✅ Orphaned ${params.taskId} (was child of ${result.previousParent})`;
      } else if (result.previousParent === null) {
        output = `✅ Set parent of ${params.taskId} to ${result.newParent}`;
      } else {
        output = `✅ Moved ${params.taskId} from parent ${result.previousParent} to ${result.newParent}`;
      }

      return { success: true, output, ...result };
    },
  };
}
