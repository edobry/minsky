import { z } from "zod";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { type CommandParameterMap, type InferParams } from "../../command-registry";
import { resolveTaskId } from "./deps-commands";
import {
  generateDependencyTree,
  generateDependencyGraph,
  generateGraphvizDot,
  renderGraphvizFormat,
} from "./deps-rendering";

// Re-export types so callers that import from this file keep working
export type { LayoutOptions, TaskNode } from "./deps-rendering";

// Parameter definitions matching the CommandParameterMap interface.
// mt#2741: canonical `taskId` (tasks_* convention) + `task` back-compat alias,
// resolved via resolveTaskId (shared with deps-commands.ts).
const tasksDepsTreeParams = {
  taskId: {
    schema: z.string().optional(),
    description: "ID of the task to show dependency tree for",
    required: false,
  },
  task: {
    schema: z.string().optional(),
    description: "Legacy alias for taskId (also accepted; prefer taskId)",
    required: false,
  },
  maxDepth: {
    schema: z.number().default(3),
    description: "Maximum depth to show in the tree",
    required: false,
  },
} satisfies CommandParameterMap;

const tasksDepsGraphParams = {
  limit: {
    schema: z.number().default(20),
    description: "Maximum number of tasks to include",
    required: false,
  },
  status: {
    schema: z.string(),
    description: "Filter tasks by status",
    required: false,
  },
  format: {
    schema: z.enum(["ascii", "dot", "svg", "png", "pdf"]).default("ascii"),
    description: "Output format: ascii (terminal), dot (Graphviz), svg/png/pdf (rendered)",
    required: false,
  },
  output: {
    schema: z.string().optional(),
    description: "Output file path (auto-generated if not specified for rendered formats)",
    required: false,
  },
  layout: {
    schema: z.enum(["dot", "neato", "fdp", "circo", "twopi"]).default("dot"),
    description:
      "Graph layout engine: dot (hierarchical), neato (spring), fdp (force), circo (circular), twopi (radial)",
    required: false,
  },
  direction: {
    schema: z
      .string()
      .default("TB")
      .transform((val) => {
        const upper = val.toUpperCase();
        if (upper === "TB" || upper === "BT") return upper as "TB" | "BT";
        throw new Error(`Invalid direction "${val}". Use TB (top-bottom) or BT (bottom-top)`);
      }),
    description:
      "Graph direction: TB (top-bottom), BT (bottom-top, tech-tree style) - case insensitive",
    required: false,
  },
  spacing: {
    schema: z.enum(["compact", "normal", "wide"]).default("normal"),
    description: "Node spacing: compact (dense), normal (balanced), wide (spread out)",
    required: false,
  },
  style: {
    schema: z.enum(["default", "tech-tree", "kanban", "mobile", "compact"]).default("default"),
    description:
      "Visual style: default (basic), tech-tree (game-style), kanban (board-compatible), mobile (narrow), compact (dense)",
    required: false,
  },
  open: {
    schema: z.boolean().default(false),
    description: "Automatically open the rendered file in the default application",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * ASCII Tree visualization for task dependencies
 */
export function createTasksDepsTreeCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return {
    id: "tasks.deps.tree",
    name: "tree",
    description: "Show dependency tree for a specific task",
    parameters: tasksDepsTreeParams,
    execute: async (params: InferParams<typeof tasksDepsTreeParams>) => {
      const taskId = resolveTaskId(params, "tasks.deps.tree");
      const graphService = getTaskGraphService();
      const taskService = getTaskService();
      const output = await generateDependencyTree(
        taskId,
        graphService,
        taskService,
        params.maxDepth || 3
      );
      return { success: true, output };
    },
  };
}

/**
 * ASCII Graph visualization for all task dependencies
 */
export function createTasksDepsGraphCommand(
  getTaskGraphService: () => TaskGraphService,
  getTaskService: () => TaskServiceInterface
) {
  return {
    id: "tasks.deps.graph",
    name: "graph",
    description: "Show ASCII graph of all task dependencies",
    parameters: tasksDepsGraphParams,
    execute: async (params: InferParams<typeof tasksDepsGraphParams>) => {
      const graphService = getTaskGraphService();
      const taskService = getTaskService();

      if (params.format === "dot") {
        const output = await generateGraphvizDot(
          graphService,
          taskService,
          params.limit || 20,
          params.status,
          {
            layout: params.layout,
            direction: params.direction,
            spacing: params.spacing,
            style: params.style,
          }
        );
        return { success: true, output };
      } else if (params.format === "svg" || params.format === "png" || params.format === "pdf") {
        const result = await renderGraphvizFormat(
          graphService,
          taskService,
          params.limit || 20,
          params.status,
          params.format,
          params.output,
          {
            layout: params.layout,
            direction: params.direction,
            spacing: params.spacing,
            style: params.style,
          },
          params.open
        );
        return { success: true, output: result.message, filePath: result.filePath };
      } else {
        const output = await generateDependencyGraph(
          graphService,
          taskService,
          params.limit || 20,
          params.status
        );
        return { success: true, output };
      }
    },
  };
}
