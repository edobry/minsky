/**
 * Task Orchestrate Command
 *
 * Finds unblocked subtasks of a parent task and returns them ready for dispatch.
 *
 * The frontier computation itself lives in
 * `@minsky/domain/tasks/umbrella-frontier` (mt#4571). It was extracted from this
 * file so the unattended supervisor and this command answer "is this child
 * blocked?" with ONE implementation — a supervisor that computed it differently
 * from the command an operator inspects it with would dispatch blocked work and
 * report that it had not.
 *
 * This command keeps its historical `["TODO"]` status default; the supervisor
 * passes an explicit filter. That default is supplied HERE, at the command
 * boundary, rather than in the shared function — see that module's docblock for
 * why the shared function deliberately has none.
 */
import { z } from "zod";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import {
  computeUmbrellaFrontier,
  type UmbrellaFrontierDeps,
} from "@minsky/domain/tasks/umbrella-frontier";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import { log } from "@minsky/shared/logger";

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

/**
 * Bind the shared frontier computation to the real graph + task services.
 *
 * Exported so the supervisor's production wiring builds its dependencies the
 * same way rather than re-deriving which `TaskGraphService` method answers
 * which half (mt#4571).
 */
export function createUmbrellaFrontierDeps(
  graphService: TaskGraphService,
  taskService: TaskServiceInterface
): UmbrellaFrontierDeps {
  return {
    listChildren: (parentTaskId) => graphService.listChildren(parentTaskId),
    getDependsRelationships: async (taskIds) =>
      await graphService.getRelationshipsForTasks(taskIds, "depends"),
    getTasks: async (taskIds) => {
      const tasks = await taskService.getTasks(taskIds);
      return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
    },
  };
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

      const frontier = await computeUmbrellaFrontier(
        parentTaskId,
        statusFilter,
        createUmbrellaFrontierDeps(getTaskGraphService(), getTaskService())
      );

      if (frontier.total === 0 && frontier.filteredOut === 0) {
        return {
          success: true,
          parentTaskId,
          dispatchable: [],
          total: 0,
          message: `${parentTaskId} has no subtasks`,
        };
      }

      const { dispatchable, blocked } = frontier;

      // Format output
      const lines: string[] = [];
      lines.push(
        `${parentTaskId}: ${dispatchable.length} of ${frontier.total} subtask(s) ready for dispatch`
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
          `  tasks_dispatch(parentTaskId: "${parentTaskId}", title: "...", instructions: "...",`
        );
        lines.push(`    premiseClaim: "...", premiseFalsifier: "...", premiseEvidence: "...")`);
        lines.push(
          `  (mt#2488 evidence gate: state the premise this dispatch rests on, the cheapest`
        );
        lines.push(`   check that would disprove it, and the result of running that check.)`);
        lines.push("Or start a session directly for an existing subtask:");
        lines.push(`  session_start(task: "${dispatchable[0]?.taskId}")`);
      }

      return {
        success: true,
        parentTaskId,
        dispatchable,
        blocked,
        total: frontier.total,
        output: lines.join("\n"),
      };
    },
  };
}
