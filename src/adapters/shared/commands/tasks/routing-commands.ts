import { z } from "zod";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import type { AvailableTask, TaskRoutingService } from "@minsky/domain/tasks/task-routing-service";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import {
  computeAutonomyClass,
  countExcluded,
  emptyExcludedByClass,
  isServableClass,
  specSignalsFromContent,
  type AutonomySpecSignals,
  type ExcludedByClass,
  type TaskAutonomyClass,
} from "@minsky/domain/tasks/autonomy-class";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import { assertKnownKind } from "@minsky/domain/tasks/workflows";
import { TaskParameters } from "../../common-parameters";

// Re-export RouteStep for callers that reference it from this file
export type { RouteStep } from "@minsky/domain/tasks/task-routing-service";

// Parameter definitions for available tasks command
const tasksAvailableParams = {
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
  // Reuses the shared, workflow-registry-derived enum (mt#2762) — same schema as
  // tasks_list / tasks_search / tasks_edit, so CLI --help and MCP JSON-schema both
  // show the enum values (reviewer finding, PR #1912 R1).
  kind: TaskParameters.kind,
  limit: {
    schema: z.number().default(20),
    // defaultValue (not schema.default) is what the CLI/MCP bridges materialize for
    // omitted args — a schema-only default is never applied at runtime (mt#2759).
    defaultValue: 20,
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
    schema: z.number().min(0).max(1).default(0.5),
    // defaultValue is required for the bridges to apply the default; without it an
    // omitted minReadiness reached the filter as undefined, and `score >= undefined`
    // is false for every task — tasks_available returned [] at defaults (mt#2759).
    defaultValue: 0.5,
    description: "Minimum readiness score (0.0-1.0) - default 0.5 shows partially-ready tasks",
    required: false,
  },
} satisfies CommandParameterMap;

// Parameter definitions for route command
const tasksRouteParams = {
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
  // mt#2795: the former `parallel` param ("Show parallel execution
  // opportunities") was declared-but-unread since the command shipped — the
  // handler never threaded it and TaskRoutingService's parallel-track
  // detection is an unimplemented TODO. Removed so the declared surface
  // matches real behavior; mt#2834 implements the feature and reinstates it.
  json: {
    schema: z.boolean().default(false),
    description: "Output in JSON format",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Command to show all tasks currently available to work on (unblocked)
 */
export function createTasksAvailableCommand(
  getPersistenceProvider: () => PersistenceProvider,
  getTaskRoutingService: () => TaskRoutingService,
  getTaskService: () => TaskServiceInterface
) {
  return {
    id: "tasks.available",
    name: "available",
    description: "Show tasks currently available to work on (unblocked by dependencies)",
    parameters: tasksAvailableParams,
    execute: async (params: InferParams<typeof tasksAvailableParams>) => {
      const provider = getPersistenceProvider();

      // Validate kind against the workflow registry up front (mt#2762), mirroring
      // tasks_list / tasks_search / tasks_edit.
      assertKnownKind(params.kind);

      // Parse status filter
      const statusFilter = params.status
        ? params.status.split(",").map((s: string) => s.trim())
        : ["TODO", "IN-PROGRESS"];

      // Belt-and-suspenders for bridge-materialized defaults (mt#2759): direct
      // execute() callers (or a bridge that fails to materialize defaultValue)
      // must still get the documented defaults.
      const limit = (params.limit as number | undefined) ?? 20;

      // Track whether we have dependency data available
      let dependencyDataAvailable = true;
      let availableTasks: AvailableTask[] | undefined;
      // Consumer-side default-deny on the computed autonomy class (mt#5130):
      // how many candidates were not served, so the exclusion is visible.
      let excludedByClass: ExcludedByClass = emptyExcludedByClass();

      // Try to use the full routing service with dependency graph
      const hasSql = provider.capabilities.sql;

      if (hasSql) {
        const routingService = getTaskRoutingService();

        try {
          const result = await routingService.findAvailableTasksWithClass({
            statusFilter,
            backendFilter: params.backend,
            kind: params.kind,
            limit,
            showEffort: params.showEffort,
            showPriority: params.showPriority,
          });
          availableTasks = result.tasks;
          excludedByClass = result.excludedByClass;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("no such table: task_relationships")
          ) {
            dependencyDataAvailable = false;
          } else {
            throw error;
          }
        }
      } else {
        dependencyDataAvailable = false;
      }

      // Fall back to listing tasks without dependency scoring
      if (!dependencyDataAvailable) {
        const fallbackTaskService = getTaskService();

        const listedTasks = await fallbackTaskService.listTasks({
          status: statusFilter.length === 1 ? statusFilter[0] : undefined,
          kind: params.kind,
        });

        // ADR-046 (mt#2911): same consumer-side default-deny as the routing
        // service path — a work package is claimed deliberately, never
        // auto-served; an explicit kind filter includes it.
        const allTasks = params.kind
          ? listedTasks
          : listedTasks.filter((task) => task.kind !== "work-package");

        const filteredTasks = params.backend
          ? allTasks.filter((task) => task.id.startsWith(params.backend as string))
          : allTasks;

        const statusFilteredTasks =
          statusFilter.length > 1
            ? filteredTasks.filter((task) => statusFilter.includes(task.status))
            : filteredTasks;

        // No bulk spec source on this path (mt#5130), so the spec is read per
        // candidate through the task service — bounded: the walk stops once
        // `limit` servable tasks are in hand, so it costs at most `limit` plus
        // the withheld count in reads, on a backend that is a file store
        // whenever this path is reachable. A spec that cannot be read leaves
        // the class `unknown`, which is withheld and counted, never served.
        const classed: Array<{
          task: (typeof statusFilteredTasks)[number];
          cls: TaskAutonomyClass;
        }> = [];
        for (const task of statusFilteredTasks) {
          if (classed.length >= limit) break;
          let spec: AutonomySpecSignals | undefined;
          try {
            const read = await fallbackTaskService.getTaskSpecContent(task.id);
            spec = specSignalsFromContent(read.content);
          } catch {
            spec = undefined;
          }
          const { class: cls } = computeAutonomyClass({
            id: task.id,
            kind: task.kind,
            status: task.status,
            tags: task.tags ?? [],
            title: task.title ?? "",
            spec,
            humanOrigin: undefined,
          });
          if (isServableClass(cls)) classed.push({ task, cls });
          else countExcluded(excludedByClass, cls);
        }

        availableTasks = classed.map(({ task, cls }) => ({
          taskId: task.id,
          title: task.title || "Unknown",
          status: task.status,
          readinessScore: 1.0,
          blockedBy: [] as string[],
          backend: task.id.includes("#") ? task.id.split("#")[0] : undefined,
          autonomyClass: cls,
        }));
      }

      // Filter by readiness score (default 0.5 = shows partially-ready tasks).
      // Belt-and-suspenders: tolerate an absent value even if a bridge fails to
      // materialize the declared default (the mt#2759 failure mode).
      const minReadiness = (params.minReadiness as number | undefined) ?? 0.5;
      const readyTasks = (availableTasks ?? []).filter(
        (task) => task.readinessScore >= minReadiness
      );

      if (params.json) {
        return {
          success: true,
          data: {
            availableTasks: readyTasks,
            count: readyTasks.length,
            dependencyDataAvailable,
            excludedByClass,
          },
        };
      }

      // Generate human-readable output
      let output = `📋 Available Tasks (${readyTasks.length} unblocked)\n`;
      output += `${"━".repeat(60)}\n`;
      if (!dependencyDataAvailable) {
        output += `⚠️  Dependency data unavailable — all tasks shown as available (no SQL backend); autonomy class computed from a per-task spec read, so a spec that could not be read is unknown and withheld\n`;
      }
      const excludedTotal = excludedByClass.principalGated + excludedByClass.unknown;
      if (excludedTotal > 0) {
        output += `🚫 Withheld by autonomy class: ${excludedByClass.principalGated} principal-gated, ${excludedByClass.unknown} unknown (never auto-served — a person decides)\n`;
      }
      output += `\n`;

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
        (t) => t.readinessScore <= 0.5 && t.readinessScore >= minReadiness
      );

      if (fullyReady.length > 0) {
        output += "✅ **Ready to Start**\n";
        for (const task of fullyReady.slice(0, 10)) {
          const cls = task.autonomyClass ? `, ${task.autonomyClass}` : "";
          output += `   ${task.taskId}: ${task.title.substring(0, 60)}... (${task.status}${cls})\n`;
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
export function createTasksRouteCommand(
  getPersistenceProvider: () => PersistenceProvider,
  getTaskRoutingService: () => TaskRoutingService
) {
  return {
    id: "tasks.route",
    name: "route",
    description: "Generate implementation route to target task",
    parameters: tasksRouteParams,
    execute: async (params: InferParams<typeof tasksRouteParams>) => {
      const provider = getPersistenceProvider();

      if (!provider.capabilities.sql) {
        // Provider already in hand — the domain helper directly (mt#3661).
        throw new Error(
          `tasks.route: SQL operations unavailable — ${describePersistenceUnavailability(provider)}`
        );
      }

      const routingService = getTaskRoutingService();

      let route;
      try {
        route = await routingService.generateRoute(params.target, params.strategy);
      } catch (error) {
        if (error instanceof Error && error.message.includes("no such table: task_relationships")) {
          return {
            success: false,
            error:
              "Task relationships table not found. This feature requires PostgreSQL backend or database migration.",
          };
        }
        throw error;
      }

      if (params.json) {
        return {
          success: true,
          data: route,
        };
      }

      // Generate human-readable route plan
      let output = `🎯 Route to ${route.targetTaskId}: ${route.targetTitle}\n`;
      output += `📊 Strategy: ${route.strategy} | Tasks: ${route.totalTasks} | Ready: ${route.readyTasks} | Blocked: ${route.blockedTasks}`;
      if (route.targetAutonomyClass) output += ` | Class: ${route.targetAutonomyClass}`;
      output += `\n${"━".repeat(80)}\n\n`;

      // A route to a gated target is still a legal navigation query; what it
      // must not say is "ready to start" (mt#5130).
      const targetGated =
        route.targetAutonomyClass === "principal-gated" || route.targetAutonomyClass === "unknown";
      if (targetGated) {
        const why = (route.targetAutonomyReasons ?? []).join("; ") || "no reason recorded";
        output += `⛔ Target is ${route.targetAutonomyClass} (${why}) — a person decides; it is never auto-selected.\n\n`;
      }

      if (route.steps.length === 0) {
        output += targetGated
          ? "Target task has no dependencies."
          : "✅ Target task has no dependencies - ready to start immediately!";
        return { success: true, output };
      }

      // Group steps by depth for phase visualization
      const stepsByDepth = new Map<number, typeof route.steps>();
      for (const step of route.steps) {
        if (!stepsByDepth.has(step.depth)) {
          stepsByDepth.set(step.depth, []);
        }
        stepsByDepth.get(step.depth)?.push(step);
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
          const gated =
            step.autonomyClass === "principal-gated" || step.autonomyClass === "unknown";
          const classText = gated ? ` [${step.autonomyClass}]` : "";

          output += `   ${statusIcon} ${step.taskId}: ${step.title.substring(0, 60)}...${depText}${classText}\n`;
        }
        output += "\n";
      }

      output += "💡 Use 'minsky tasks available' to see what you can start working on now";

      return { success: true, output };
    },
  };
}
