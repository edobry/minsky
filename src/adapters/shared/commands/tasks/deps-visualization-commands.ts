import { z } from "zod";
import type { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "../../../../domain/tasks/taskService";
import { type CommandParameterMap } from "../../command-registry";
import {
  generateDependencyTree,
  generateDependencyGraph,
  generateGraphvizDot,
  renderGraphvizFormat,
} from "./deps-rendering";

// Re-export types so callers that import from this file keep working
export type { LayoutOptions, TaskNode } from "./deps-rendering";

// Parameter definitions matching the CommandParameterMap interface
const tasksDepsTreeParams = {
  task: {
    schema: z.string(),
    description: "ID of the task to show dependency tree for",
    required: true,
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

interface TasksDepsTreeParams {
  task: string;
  maxDepth: number;
}

interface TasksDepsGraphParams {
  limit: number;
  status: string;
  format: "ascii" | "dot" | "svg" | "png" | "pdf";
  output?: string;
  layout: "dot" | "neato" | "fdp" | "circo" | "twopi";
  direction: "TB" | "BT";
  spacing: "compact" | "normal" | "wide";
  style: "default" | "tech-tree" | "kanban" | "mobile" | "compact";
  open: boolean;
}

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
    execute: async (params: TasksDepsTreeParams) => {
      const graphService = getTaskGraphService();
      const taskService = getTaskService();
      const output = await generateDependencyTree(
        params.task,
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
    execute: async (params: TasksDepsGraphParams) => {
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
