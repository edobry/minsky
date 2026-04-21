/**
 * Task Orchestrate Command
 *
 * Finds unblocked subtasks of a parent task and returns them ready for dispatch.
 * Composes TaskGraphService (children + deps) with task status resolution.
 */
import { z } from "zod";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import { log } from "../../../../utils/logger";

const tasksOrchestrateParams = {
  taskId: {
    schema: z.string(),
    description: "Parent task ID to find dispatchable subtasks for",
    required: true,
  },
  status: {
    schema: z.string().optional(),
    description: "Subtask statuses to include (comma-separated, default: TODO)",
    required: false,
  },
} satisfies CommandParameterMap;

interface DispatchableSubtask {
  taskId: string;
  title: string;
  status: string;
  blockedBy: string[];
  ready: boolean;
}

export function createTasksOrchestrateCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return {
    id: "tasks.orchestrate",
    name: "orchestrate",
    description: "Find unblocked subtasks of a parent task, ready for dispatch via tasks_dispatch",
    parameters: tasksOrchestrateParams,
    execute: async (params: InferParams<typeof tasksOrchestrateParams>) => {
      const parentTaskId = params.taskId as string;
      const statusFilter = params.status
        ? (params.status as string).split(",").map((s) => s.trim())
        : ["TODO"];

      log.debug("[tasks.orchestrate] Finding dispatchable subtasks", {
        parentTaskId,
        statusFilter,
      });

      const service = getTaskGraphService();

      // Step 1: Get children of the parent
      const childIds = await service.listChildren(parentTaskId);

      if (childIds.length === 0) {
        return {
          success: true,
          parentTaskId,
          dispatchable: [],
          total: 0,
          message: `${parentTaskId} has no subtasks`,
        };
      }

      // Step 2: Get status + deps for each child
      const taskService = getTaskService();

      const allSubtasks: DispatchableSubtask[] = [];

      for (const childId of childIds) {
        let title = "(unknown)";
        let status = "UNKNOWN";

        try {
          const task = await taskService.getTask(childId);
          if (task) {
            title = task.title;
            status = task.status;
          }
        } catch {
          // Task not found in backend — use defaults
        }

        // Skip tasks not in the target status filter
        if (!statusFilter.includes(status)) {
          continue;
        }

        // Check deps — which are unmet?
        const deps = await service.listDependencies(childId);
        const blockedBy: string[] = [];

        for (const depId of deps) {
          try {
            const depTask = await taskService.getTask(depId);
            if (depTask && depTask.status !== "DONE" && depTask.status !== "CLOSED") {
              blockedBy.push(depId);
            }
          } catch {
            blockedBy.push(depId); // Can't resolve → assume blocking
          }
        }

        allSubtasks.push({
          taskId: childId,
          title,
          status,
          blockedBy,
          ready: blockedBy.length === 0,
        });
      }

      const dispatchable = allSubtasks.filter((s) => s.ready);
      const blocked = allSubtasks.filter((s) => !s.ready);

      // Format output
      const lines: string[] = [];
      lines.push(
        `${parentTaskId}: ${dispatchable.length} of ${allSubtasks.length} subtask(s) ready for dispatch`
      );

      if (dispatchable.length > 0) {
        lines.push("");
        lines.push("Ready:");
        for (const sub of dispatchable) {
          lines.push(`  ${sub.taskId}: ${sub.title} [${sub.status}]`);
        }
      }

      if (blocked.length > 0) {
        lines.push("");
        lines.push("Blocked:");
        for (const sub of blocked) {
          lines.push(
            `  ${sub.taskId}: ${sub.title} [${sub.status}] ← blocked by ${sub.blockedBy.join(", ")}`
          );
        }
      }

      if (dispatchable.length > 0) {
        lines.push("");
        lines.push("To dispatch a subtask:");
        lines.push(
          `  tasks_dispatch(parentTaskId: "${parentTaskId}", title: "...", instructions: "...")`
        );
        lines.push("Or start a session directly for an existing subtask:");
        lines.push(`  session_start(task: "${dispatchable[0]?.taskId}")`);
      }

      return {
        success: true,
        parentTaskId,
        dispatchable,
        blocked,
        total: allSubtasks.length,
        output: lines.join("\n"),
      };
    },
  };
}
