import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DatabaseConnectionManager } from "../../../../domain/database/connection-manager";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { createConfiguredTaskService } from "../../../../domain/tasks/taskService";
import { type CommandParameterMap } from "../../command-registry";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { Graphviz } from "@hpcc-js/wasm/graphviz";

// Parameter definitions matching the CommandParameterMap interface
const tasksDepsTreeParams: CommandParameterMap = {
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
};

const tasksDepsGraphParams: CommandParameterMap = {
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
    schema: z.string().default("TB").transform(val => {
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
};

interface TaskNode {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  dependents: string[];
}

/**
 * ASCII Tree visualization for task dependencies
 */
export function createTasksDepsTreeCommand() {
  return {
    id: "tasks.deps.tree",
    name: "tree",
    description: "Show dependency tree for a specific task",
    parameters: tasksDepsTreeParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
      const graphService = new TaskGraphService(db);
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
      });

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
export function createTasksDepsGraphCommand() {
  return {
    id: "tasks.deps.graph",
    name: "graph",
    description: "Show ASCII graph of all task dependencies",
    parameters: tasksDepsGraphParams,
    execute: async (params: any) => {
      const db: PostgresJsDatabase = await DatabaseConnectionManager.getInstance().getConnection();
      const graphService = new TaskGraphService(db);
      const taskService = await createConfiguredTaskService({
        workspacePath: process.cwd(),
      });

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
          }
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

/**
 * Generate ASCII tree for a specific task's dependencies
 */
async function generateDependencyTree(
  taskId: string,
  graphService: TaskGraphService,
  taskService: any,
  maxDepth: number
): Promise<string> {
  const lines: string[] = [];

  try {
    // Get the root task info
    const task = await taskService.getTask(taskId);
    if (!task) {
      return `❌ Task ${taskId} not found`;
    }

    lines.push(`🌳 Dependency Tree for ${taskId}`);
    lines.push(`━`.repeat(60));
    lines.push(`📋 ${task.title} (${task.status || "Unknown"})`);
    lines.push("");

    // Get dependencies and dependents
    const dependencies = await graphService.listDependencies(taskId);
    const dependents = await graphService.listDependents(taskId);

    // Show what this task depends on
    if (dependencies.length > 0) {
      lines.push("⬅️  Dependencies (this task depends on):");
      for (let i = 0; i < dependencies.length; i++) {
        const dep = dependencies[i];
        const isLast = i === dependencies.length - 1;
        const connector = isLast ? "└── " : "├── ";

        try {
          const depTask = await taskService.getTask(dep);
          const title = depTask?.title || "Unknown";
          const status = depTask?.status || "Unknown";
          lines.push(`  ${connector}${dep}: ${title} (${status})`);

          // Recursively show dependencies if within depth limit
          if (maxDepth > 1) {
            const subDeps = await graphService.listDependencies(dep);
            for (let j = 0; j < subDeps.length && j < 3; j++) {
              const subDep = subDeps[j];
              const subConnector = isLast ? "    └── " : "│   └── ";
              try {
                const subDepTask = await taskService.getTask(subDep);
                lines.push(`  ${subConnector}${subDep}: ${subDepTask?.title || "Unknown"}`);
              } catch {
                lines.push(`  ${subConnector}${subDep}: [Task not found]`);
              }
            }
            if (subDeps.length > 3) {
              const moreConnector = isLast ? "    " : "│   ";
              lines.push(`  ${moreConnector}... and ${subDeps.length - 3} more`);
            }
          }
        } catch {
          lines.push(`  ${connector}${dep}: [Task not found]`);
        }
      }
      lines.push("");
    }

    // Show what depends on this task
    if (dependents.length > 0) {
      lines.push("➡️  Dependents (tasks that depend on this):");
      for (let i = 0; i < dependents.length; i++) {
        const dependent = dependents[i];
        const isLast = i === dependents.length - 1;
        const connector = isLast ? "└── " : "├── ";

        try {
          const depTask = await taskService.getTask(dependent);
          const title = depTask?.title || "Unknown";
          const status = depTask?.status || "Unknown";
          lines.push(`  ${connector}${dependent}: ${title} (${status})`);
        } catch {
          lines.push(`  ${connector}${dependent}: [Task not found]`);
        }
      }
    }

    if (dependencies.length === 0 && dependents.length === 0) {
      lines.push("🔍 No dependencies or dependents found");
    }
  } catch (error) {
    lines.push(`❌ Error generating tree: ${error.message}`);
  }

  return lines.join("\n");
}

/**
 * Generate ASCII graph of all task dependencies
 */
async function generateDependencyGraph(
  graphService: TaskGraphService,
  taskService: any,
  limit: number,
  statusFilter?: string
): Promise<string> {
  const lines: string[] = [];

  try {
    // Get tasks with dependencies
    const tasks = await taskService.listTasks({
      status: statusFilter || "TODO",
      limit: Math.min(limit, 50), // Cap at reasonable limit
    });

    lines.push(`🕸️  Task Dependency Graph`);
    lines.push(`━`.repeat(60));
    lines.push(`Showing ${statusFilter || "TODO"} tasks with dependencies\n`);

    const tasksWithDeps = [];

    // PERFORMANCE OPTIMIZATION: Single bulk query instead of N individual queries
    const taskIds = tasks.map((t) => t.id);
    const allRelationships = await graphService.getRelationshipsForTasks(taskIds);

    // Build dependency maps in memory from single query result
    const dependenciesMap = new Map<string, string[]>();
    const dependentsMap = new Map<string, string[]>();

    allRelationships.forEach(({ fromTaskId, toTaskId }) => {
      // Track dependencies: fromTaskId depends on toTaskId
      if (!dependenciesMap.has(fromTaskId)) {
        dependenciesMap.set(fromTaskId, []);
      }
      dependenciesMap.get(fromTaskId)!.push(toTaskId);

      // Track dependents: toTaskId has fromTaskId as dependent
      if (!dependentsMap.has(toTaskId)) {
        dependentsMap.set(toTaskId, []);
      }
      dependentsMap.get(toTaskId)!.push(fromTaskId);
    });

    // Filter tasks to only those with actual relationships
    for (const task of tasks) {
      const dependencies = dependenciesMap.get(task.id) || [];
      const dependents = dependentsMap.get(task.id) || [];

      if (dependencies.length > 0 || dependents.length > 0) {
        tasksWithDeps.push({
          ...task,
          dependencies,
          dependents,
        });
      }
    }

    if (tasksWithDeps.length === 0) {
      lines.push("🔍 No tasks with dependencies found");
      return lines.join("\n");
    }

    lines.push(`Found ${tasksWithDeps.length} tasks with dependencies:\n`);

    // Group by dependency chains
    const processed = new Set<string>();
    const chains = [];

    // Find root tasks (tasks with no dependencies)
    const rootTasks = tasksWithDeps.filter((t) => t.dependencies.length === 0);

    for (const root of rootTasks) {
      if (!processed.has(root.id)) {
        const chain = await buildDependencyChain(root, tasksWithDeps, graphService, processed);
        if (chain.length > 0) {
          chains.push(chain);
        }
      }
    }

    // Add remaining unprocessed tasks
    for (const task of tasksWithDeps) {
      if (!processed.has(task.id)) {
        chains.push([task]);
        processed.add(task.id);
      }
    }

    // Render chains
    for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
      const chain = chains[chainIndex];
      const isLastChain = chainIndex === chains.length - 1;

      await renderDependencyChain(chain, lines, graphService, taskService, isLastChain);

      if (!isLastChain) {
        lines.push("");
      }
    }
  } catch (error) {
    lines.push(`❌ Error generating graph: ${error.message}`);
  }

  return lines.join("\n");
}

/**
 * Build a dependency chain starting from a root task
 */
async function buildDependencyChain(
  root: any,
  allTasks: any[],
  graphService: TaskGraphService,
  processed: Set<string>
): Promise<any[]> {
  const chain = [root];
  processed.add(root.id);

  // Follow the chain of dependents
  let current = root;
  const visited = new Set([root.id]);

  while (current.dependents.length > 0) {
    // Find the first unprocessed dependent
    const nextTaskId = current.dependents.find(
      (depId) => !processed.has(depId) && !visited.has(depId)
    );

    if (!nextTaskId) break;

    const nextTask = allTasks.find((t) => t.id === nextTaskId);
    if (!nextTask) break;

    chain.push(nextTask);
    processed.add(nextTask.id);
    visited.add(nextTask.id);
    current = nextTask;
  }

  return chain;
}

/**
 * Render a dependency chain using ASCII tree characters
 */
async function renderDependencyChain(
  chain: any[],
  lines: string[],
  graphService: TaskGraphService,
  taskService: any,
  isLastChain: boolean
) {
  for (let i = 0; i < chain.length; i++) {
    const task = chain[i];
    const isLast = i === chain.length - 1;
    const isFirst = i === 0;

    // Determine connector
    let connector = "";
    if (chain.length === 1) {
      connector = "● ";
    } else if (isFirst) {
      connector = "┌─ ";
    } else if (isLast) {
      connector = "└─ ";
    } else {
      connector = "├─ ";
    }

    // Task info
    const title = task.title.length > 50 ? `${task.title.substring(0, 47)}...` : task.title;

    lines.push(`${connector}${task.id}: ${title} (${task.status})`);

    // Show additional dependents branching off
    if (task.dependents.length > 1) {
      const otherDependents = task.dependents.filter((depId) => !chain.some((t) => t.id === depId));

      for (let j = 0; j < Math.min(otherDependents.length, 2); j++) {
        const depId = otherDependents[j];
        try {
          const depTask = await taskService.getTask(depId);
          const depTitle = depTask?.title?.substring(0, 40) || "Unknown";
          const branchConnector = isLast ? "  └─ " : "│ └─ ";
          lines.push(`${branchConnector}${depId}: ${depTitle}`);
        } catch {
          // Skip tasks that can't be loaded
        }
      }

      if (otherDependents.length > 2) {
        const moreConnector = isLast ? "  " : "│ ";
        lines.push(`${moreConnector}   ... +${otherDependents.length - 2} more`);
      }
    }
  }
}

interface LayoutOptions {
  layout?: string;
  direction?: string;
  spacing?: string;
  style?: string;
}

/**
 * Generate Graphviz DOT format for task dependencies
 */
async function generateGraphvizDot(
  graphService: TaskGraphService,
  taskService: any,
  limit: number,
  statusFilter?: string,
  options: LayoutOptions = {}
): Promise<string> {
  const lines: string[] = [];

  try {
    // Get tasks with dependencies
    const tasks = await taskService.listTasks({
      status: statusFilter || "TODO",
      limit: Math.min(limit, 100), // Higher limit for DOT since it's for external processing
    });

    const { layout = "dot", direction = "TB", spacing = "normal", style = "default" } = options;

    lines.push("digraph TaskDependencies {");

    // Layout engine (for rendering, not DOT syntax)
    if (layout !== "dot") {
      lines.push(`  layout="${layout}";`);
    }

    // Direction
    lines.push(`  rankdir=${direction};`);

    // Spacing configuration
    let ranksep = "0.75";
    let nodesep = "0.5";
    if (spacing === "compact") {
      ranksep = "0.5";
      nodesep = "0.3";
    } else if (spacing === "wide") {
      ranksep = "1.2";
      nodesep = "0.8";
    }
    lines.push(`  ranksep=${ranksep};`);
    lines.push(`  nodesep=${nodesep};`);

    // Style configuration optimized for vertical layouts
    if (style === "tech-tree") {
      lines.push(`  node [shape=box, style="rounded,filled", fontname=Arial, fontsize=10];`);
      lines.push(`  edge [color="#4a5568", arrowsize=0.8, style=bold];`);
      lines.push(`  bgcolor="transparent";`);
      lines.push(`  concentrate=true;`); // Merge multiple edges
    } else if (style === "kanban") {
      // Optimized for kanban board integration - narrow, column-friendly
      lines.push(
        `  node [shape=box, style="rounded,filled", fontname=Arial, fontsize=9, width=1.5, height=0.8];`
      );
      lines.push(`  edge [color="#6b7280", arrowsize=0.6];`);
      lines.push(`  bgcolor="white";`);
      lines.push(`  margin="0.1";`);
    } else if (style === "mobile") {
      // Optimized for mobile/narrow screens
      lines.push(
        `  node [shape=box, style="rounded,filled", fontname=Arial, fontsize=8, width=1.2];`
      );
      lines.push(`  edge [color="#374151", arrowsize=0.5];`);
      lines.push(`  bgcolor="transparent";`);
      lines.push(`  margin="0.05";`);
    } else if (style === "compact") {
      // Dense layout for IDE panels/terminals
      lines.push(
        `  node [shape=box, style="filled", fontname=Consolas, fontsize=8, width=1.0, height=0.6];`
      );
      lines.push(`  edge [color="#6b7280", arrowsize=0.4];`);
      lines.push(`  margin="0";`);
    } else {
      lines.push(`  node [shape=box, style=rounded];`);
      lines.push(`  edge [color=gray];`);
    }

    lines.push("");

    const tasksWithDeps = [];
    const allTaskIds = new Set<string>();

    // PERFORMANCE OPTIMIZATION: Single bulk query instead of N individual queries
    const taskIds = tasks.map((t) => t.id);
    const allRelationships = await graphService.getRelationshipsForTasks(taskIds);

    // Build dependency maps in memory from single query result
    const dependenciesMap = new Map<string, string[]>();
    const dependentsMap = new Map<string, string[]>();

    allRelationships.forEach(({ fromTaskId, toTaskId }) => {
      // Track dependencies: fromTaskId depends on toTaskId
      if (!dependenciesMap.has(fromTaskId)) {
        dependenciesMap.set(fromTaskId, []);
      }
      dependenciesMap.get(fromTaskId)!.push(toTaskId);

      // Track dependents: toTaskId has fromTaskId as dependent
      if (!dependentsMap.has(toTaskId)) {
        dependentsMap.set(toTaskId, []);
      }
      dependentsMap.get(toTaskId)!.push(fromTaskId);

      allTaskIds.add(fromTaskId);
      allTaskIds.add(toTaskId);
    });

    // Filter tasks to only those with actual relationships
    for (const task of tasks) {
      const dependencies = dependenciesMap.get(task.id) || [];
      const dependents = dependentsMap.get(task.id) || [];

      if (dependencies.length > 0 || dependents.length > 0) {
        tasksWithDeps.push({
          ...task,
          dependencies,
          dependents,
        });
      }
    }

    if (tasksWithDeps.length === 0) {
      lines.push("  // No tasks with dependencies found");
      lines.push("}");
      return lines.join("\n");
    }

    // PERFORMANCE FIX: Batch all task detail queries
    const taskDetailsMap = new Map<string, any>();
    const taskDetailsResults = await Promise.allSettled(
      Array.from(allTaskIds).map(async (taskId) => {
        const task = await taskService.getTask(taskId);
        return { taskId, task };
      })
    );

    // Process results from batch query
    taskDetailsResults.forEach((result) => {
      if (result.status === "fulfilled") {
        taskDetailsMap.set(result.value.taskId, result.value.task);
      }
    });

    // Define nodes with labels and colors based on cached task details
    for (const taskId of allTaskIds) {
      const task = taskDetailsMap.get(taskId);
      const safeId = taskId.replace(/[^a-zA-Z0-9]/g, "_");

      if (task) {
        const title = (task.title?.substring(0, 30) || "Unknown")
          .replace(/"/g, "'") // Replace double quotes with single quotes
          .replace(/\n/g, " ") // Replace newlines with spaces
          .replace(/\r/g, " "); // Replace carriage returns with spaces
        const status = task.status || "Unknown";

        let color = "lightgray";
        let shape = "box";
        let borderColor = "black";

        if (style === "tech-tree") {
          // Tech tree styling with game-like colors
          if (status === "TODO") {
            color = "#e2e8f0"; // Cool gray for unresearched
            borderColor = "#64748b";
          } else if (status === "IN-PROGRESS") {
            color = "#fbbf24"; // Bright yellow for researching
            borderColor = "#d97706";
          } else if (status === "DONE") {
            color = "#34d399"; // Bright green for completed
            borderColor = "#059669";
          } else if (status === "BLOCKED") {
            color = "#f87171"; // Red for blocked
            borderColor = "#dc2626";
          }
        } else if (style === "kanban") {
          // Kanban-compatible colors that work with column layouts
          if (status === "TODO") {
            color = "#f1f5f9"; // Light gray
            borderColor = "#64748b";
          } else if (status === "IN-PROGRESS") {
            color = "#fef3c7"; // Soft yellow
            borderColor = "#d97706";
          } else if (status === "DONE") {
            color = "#d1fae5"; // Soft green
            borderColor = "#059669";
          } else if (status === "BLOCKED") {
            color = "#fee2e2"; // Soft red
            borderColor = "#dc2626";
          }
        } else if (style === "mobile" || style === "compact") {
          // High contrast for small screens
          if (status === "TODO") {
            color = "#e5e7eb";
            borderColor = "#374151";
          } else if (status === "IN-PROGRESS") {
            color = "#fed7aa";
            borderColor = "#ea580c";
          } else if (status === "DONE") {
            color = "#bbf7d0";
            borderColor = "#16a34a";
          } else if (status === "BLOCKED") {
            color = "#fecaca";
            borderColor = "#dc2626";
          }
        } else {
          // Original colors for default style
          if (status === "TODO") color = "lightblue";
          else if (status === "IN-PROGRESS") color = "yellow";
          else if (status === "DONE") color = "lightgreen";
          else if (status === "BLOCKED") color = "lightcoral";
        }

        if (
          style === "tech-tree" ||
          style === "kanban" ||
          style === "mobile" ||
          style === "compact"
        ) {
          lines.push(
            `  ${safeId} [label="${taskId}\\n${title}", fillcolor="${color}", color="${borderColor}", penwidth=${style === "compact" ? "1" : "2"}];`
          );
        } else {
          lines.push(
            `  ${safeId} [label="${taskId}\\n${title}", fillcolor="${color}", style=filled];`
          );
        }
      } else {
        // Handle tasks that couldn't be loaded
        const safeTaskId = taskId.replace(/"/g, "'");
        lines.push(`  ${safeId} [label="${safeTaskId}", fillcolor="lightgray", style=filled];`);
      }
    }

    lines.push("");

    // Define edges from cached relationship data
    allRelationships.forEach(({ fromTaskId, toTaskId }) => {
      const fromId = fromTaskId.replace(/[^a-zA-Z0-9]/g, "_");
      const toId = toTaskId.replace(/[^a-zA-Z0-9]/g, "_");
      lines.push(`  ${toId} -> ${fromId};`);
    });

    lines.push("}");
    return lines.join("\n");
  } catch (error) {
    lines.push("digraph TaskDependencies {");
    lines.push(`  error [label="Error: ${error.message}", color=red];`);
    lines.push("}");
    return lines.join("\n");
  }
}

/**
 * Render Graphviz DOT format to SVG, PNG, or PDF using pure JS/WASM
 */
async function renderGraphvizFormat(
  graphService: TaskGraphService,
  taskService: any,
  limit: number,
  statusFilter: string | undefined,
  format: "svg" | "png" | "pdf",
  outputPath?: string,
  layoutOptions: LayoutOptions = {}
): Promise<{ message: string; filePath: string }> {
  try {
    // Generate DOT content with layout options
    const dotContent = await generateGraphvizDot(
      graphService,
      taskService,
      limit,
      statusFilter,
      layoutOptions
    );

    // Generate output filename if not provided
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, "");
    const defaultFilename = `task-deps-${timestamp}.${format}`;
    const finalOutputPath = outputPath || join(process.cwd(), defaultFilename);

    try {
      // Render using pure JS/WASM with layout engine
      const graphviz = await Graphviz.load();
      let outputBuffer: Buffer;

      const layoutEngine = layoutOptions.layout || "dot";

      switch (format) {
        case "svg":
          outputBuffer = Buffer.from(
            await graphviz[layoutEngine as keyof typeof graphviz](dotContent, "svg"),
            "utf8"
          );
          break;
        case "png":
          outputBuffer = Buffer.from(
            await graphviz[layoutEngine as keyof typeof graphviz](dotContent, "png")
          );
          break;
        case "pdf":
          outputBuffer = Buffer.from(
            await graphviz[layoutEngine as keyof typeof graphviz](dotContent, "pdf")
          );
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      // Write output file
      writeFileSync(finalOutputPath, outputBuffer);

      return {
        message: `✅ Rendered task dependency graph to: ${finalOutputPath}`,
        filePath: finalOutputPath,
      };
    } catch (error) {
      return {
        message: `❌ Failed to render graph: ${error.message}`,
        filePath: "",
      };
    }
  } catch (error) {
    return {
      message: `❌ Error generating graph: ${error.message}`,
      filePath: "",
    };
  }
}
