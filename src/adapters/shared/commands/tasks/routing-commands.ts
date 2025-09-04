import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DatabaseConnectionManager } from "../../../../domain/database/connection-manager";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { TaskRoutingService } from "../../../../domain/tasks/task-routing-service";
import { createConfiguredTaskService } from "../../../../domain/tasks/taskService";
import { type CommandParameterMap } from "../../command-registry";

// Parameter definitions for available tasks command
const tasksAvailableParams: CommandParameterMap = {
  status: {
    schema: z.string().optional(),
    description: "Filter by task status (default: TODO,IN-PROGRESS)",
    required: false,
  },
  backend: {
    schema: z.string().optional(),
    description: "Filter by specific backend (mt, md, gh, etc.)",
    required: false,
  },
  limit: {
    schema: z.number().default(20),
    description: "Maximum number of tasks to show",
    required: false,
  },
  showEffort: {
    schema: z.boolean().default(false),
    description: "Include effort estimates if available",
    required: false,
  },
  showPriority: {
    schema: z.boolean().default(false),
    description: "Include priority information if available",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
  minReadiness: {
    schema: z.number().min(0).max(1).default(0.0),
    description: "Minimum readiness score (0.0-1.0) to include task",
    required: false,
  },
};

// Parameter definitions for route command
const tasksRouteParams: CommandParameterMap = {
  target: {
    schema: z.string(),
    description: "Target task ID to generate route for",
    required: true,
  },
  strategy: {
    schema: z.enum(["shortest-path", "value-first", "ready-first"]).default("ready-first"),
    description:
      "Routing strategy: ready-first (actionable), shortest-path (minimal), value-first (value optimized)",
    required: false,
  },
  parallel: {
    schema: z.boolean().default(false),
    description: "Show parallel execution opportunities",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
};

/**
 * Command to show all tasks currently available to work on (unblocked)
 */
export function createTasksAvailableCommand() {
  return {
    id: "tasks.available",
    name: "available",
    description: "Show tasks currently available to work on (unblocked by dependencies)",
    parameters: tasksAvailableParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await new DatabaseConnectionManager().getConnection();
      const graphService = new TaskGraphService(db);
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
      });
      const routingService = new TaskRoutingService(graphService, taskService);

      // Parse status filter
      const statusFilter = params.status
        ? params.status.split(",").map((s: string) => s.trim())
        : ["TODO", "IN-PROGRESS"];

      const availableTasks = await routingService.findAvailableTasks({
        statusFilter,
        backendFilter: params.backend,
        limit: params.limit,
        showEffort: params.showEffort,
        showPriority: params.showPriority,
      });

      // Filter by readiness score
      const readyTasks = availableTasks.filter(
        (task) => task.readinessScore >= params.minReadiness
      );

      if (params.json) {
        return {
          success: true,
          data: { availableTasks: readyTasks, count: readyTasks.length },
        };
      }

      // Generate human-readable output
      let output = `📋 Available Tasks (${readyTasks.length} unblocked)\n`;
      output += `${"━".repeat(60)}\n\n`;

      if (readyTasks.length === 0) {
        output += "No tasks available with current filters.\n";
        output += "Try adjusting --status or --backend parameters.";
        return { success: true, output };
      }

      // Group by readiness level
      const fullyReady = readyTasks.filter((t) => t.readinessScore === 1.0);
      const partiallyReady = readyTasks.filter(
        (t) => t.readinessScore > 0.5 && t.readinessScore < 1.0
      );
      const lowReadiness = readyTasks.filter(
        (t) => t.readinessScore <= 0.5 && t.readinessScore >= params.minReadiness
      );

      if (fullyReady.length > 0) {
        output += "🟢 **Fully Ready** (0 blockers)\n";
        for (const task of fullyReady.slice(0, 10)) {
          const readinessPercent = Math.round(task.readinessScore * 100);
          output += `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%)\n`;
        }
        output += "\n";
      }

      if (partiallyReady.length > 0) {
        output += "🟡 **Partially Ready** (some dependencies complete)\n";
        for (const task of partiallyReady.slice(0, 5)) {
          const readinessPercent = Math.round(task.readinessScore * 100);
          const blockerCount = task.blockedBy.length;
          output += `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%, ${blockerCount} blockers)\n`;
        }
        output += "\n";
      }

      if (lowReadiness.length > 0) {
        output += "🔴 **Low Readiness** (many dependencies pending)\n";
        for (const task of lowReadiness.slice(0, 3)) {
          const readinessPercent = Math.round(task.readinessScore * 100);
          const blockerCount = task.blockedBy.length;
          output += `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%, ${blockerCount} blockers)\n`;
        }
      }

      output += "\n💡 Use 'minsky tasks route <task-id>' to see implementation path to any task";

      return { success: true, output };
    },
  };
}

/**
 * Command to generate implementation route to a target task
 */
export function createTasksRouteCommand() {
  return {
    id: "tasks.route",
    name: "route",
    description: "Generate implementation route to target task",
    parameters: tasksRouteParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await new DatabaseConnectionManager().getConnection();
      const graphService = new TaskGraphService(db);
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
      });
      const routingService = new TaskRoutingService(graphService, taskService);

      const route = await routingService.generateRoute(params.target, params.strategy);

      if (params.json) {
        return {
          success: true,
          data: route,
        };
      }

      // Generate human-readable route plan
      let output = `🎯 Route to ${route.targetTaskId}: ${route.targetTitle}\n`;
      output += `📊 Strategy: ${route.strategy} | Tasks: ${route.totalTasks} | Ready: ${route.readyTasks} | Blocked: ${route.blockedTasks}\n`;
      output += `${"━".repeat(80)}\n\n`;

      if (route.steps.length === 0) {
        output += "✅ Target task has no dependencies - ready to start immediately!";
        return { success: true, output };
      }

      // Group steps by depth for phase visualization
      const stepsByDepth = new Map<number, RouteStep[]>();
      for (const step of route.steps) {
        if (!stepsByDepth.has(step.depth)) {
          stepsByDepth.set(step.depth, []);
        }
        stepsByDepth.get(step.depth)!.push(step);
      }

      const maxDepth = Math.max(...Array.from(stepsByDepth.keys()));

      for (let depth = maxDepth; depth >= 0; depth--) {
        const stepsAtDepth = stepsByDepth.get(depth);
        if (!stepsAtDepth || stepsAtDepth.length === 0) continue;

        if (depth === 0) {
          output += `🎯 **Target Task**\n`;
        } else {
          output += `📋 **Phase ${maxDepth - depth + 1}** (Depth ${depth})\n`;
        }

        for (const step of stepsAtDepth) {
          const statusIcon =
            step.status === "DONE"
              ? "✅"
              : step.status === "IN-PROGRESS"
                ? "🟡"
                : step.status === "BLOCKED"
                  ? "🔴"
                  : "⚪";
          const depCount = step.dependencies.length;
          const depText = depCount > 0 ? ` (${depCount} deps)` : "";

          output += `   ${statusIcon} ${step.taskId}: ${step.title.substring(0, 60)}...${depText}\n`;
        }
        output += "\n";
      }

      output += "💡 Use 'minsky tasks available' to see what you can start working on now";

      return { success: true, output };
    },
  };
}