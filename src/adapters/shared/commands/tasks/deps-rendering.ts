import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";
import { join } from "path";
import { Graphviz } from "@hpcc-js/wasm";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { getErrorMessage } from "../../../../errors/index";

const execAsync = promisify(exec);

export interface LayoutOptions {
  layout?: string;
  direction?: string;
  spacing?: string;
  style?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  dependents: string[];
}

/**
 * Generate ASCII tree for a specific task's dependencies
 */
export async function generateDependencyTree(
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
            const subDeps = await graphService.listDependencies(dep!);
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
    lines.push(`❌ Error generating tree: ${getErrorMessage(error)}`);
  }

  return lines.join("\n");
}

/**
 * Build a dependency chain starting from a root task
 */
export async function buildDependencyChain(
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
export async function renderDependencyChain(
  chain: any[],
  lines: string[],
  graphService: TaskGraphService,
  taskService: any,
  isLastChain: boolean
) {
  // graphService and isLastChain are kept for API compatibility
  void graphService;
  void isLastChain;

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

/**
 * Generate ASCII graph of all task dependencies
 */
export async function generateDependencyGraph(
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

    const tasksWithDeps: any[] = [];

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
    const chains: any[][] = [];

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
      const chain = chains[chainIndex]!;
      const isLastChain = chainIndex === chains.length - 1;

      await renderDependencyChain(chain, lines, graphService, taskService, isLastChain);

      if (!isLastChain) {
        lines.push("");
      }
    }
  } catch (error) {
    lines.push(`❌ Error generating graph: ${getErrorMessage(error)}`);
  }

  return lines.join("\n");
}

/**
 * Emit node color/style attributes for a given status and style preset.
 */
function getNodeStyleAttrs(status: string, style: string): { color: string; borderColor: string } {
  if (style === "tech-tree") {
    if (status === "TODO") return { color: "#e2e8f0", borderColor: "#64748b" };
    if (status === "IN-PROGRESS") return { color: "#fbbf24", borderColor: "#d97706" };
    if (status === "DONE") return { color: "#34d399", borderColor: "#059669" };
    if (status === "BLOCKED") return { color: "#f87171", borderColor: "#dc2626" };
  } else if (style === "kanban") {
    if (status === "TODO") return { color: "#f1f5f9", borderColor: "#64748b" };
    if (status === "IN-PROGRESS") return { color: "#fef3c7", borderColor: "#d97706" };
    if (status === "DONE") return { color: "#d1fae5", borderColor: "#059669" };
    if (status === "BLOCKED") return { color: "#fee2e2", borderColor: "#dc2626" };
  } else if (style === "mobile") {
    if (status === "TODO") return { color: "#1e40af", borderColor: "#1e3a8a" };
    if (status === "IN-PROGRESS") return { color: "#d97706", borderColor: "#92400e" };
    if (status === "DONE") return { color: "#15803d", borderColor: "#166534" };
    if (status === "BLOCKED") return { color: "#dc2626", borderColor: "#991b1b" };
  } else if (style === "compact") {
    if (status === "TODO") return { color: "#f8fafc", borderColor: "#cbd5e1" };
    if (status === "IN-PROGRESS") return { color: "#fffbeb", borderColor: "#d97706" };
    if (status === "DONE") return { color: "#f0fdf4", borderColor: "#16a34a" };
    if (status === "BLOCKED") return { color: "#fef2f2", borderColor: "#dc2626" };
  }
  // default
  if (status === "TODO") return { color: "lightblue", borderColor: "black" };
  if (status === "IN-PROGRESS") return { color: "yellow", borderColor: "black" };
  if (status === "DONE") return { color: "lightgreen", borderColor: "black" };
  if (status === "BLOCKED") return { color: "lightcoral", borderColor: "black" };
  return { color: "lightgray", borderColor: "black" };
}

/**
 * Generate Graphviz DOT format for task dependencies
 */
export async function generateGraphvizDot(
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
      // Optimized for mobile/narrow screens - bold and thick for touch
      lines.push(
        `  node [shape=box, style="rounded,filled", fontname=Arial, fontsize=8, width=1.2, penwidth=3];`
      );
      lines.push(`  edge [color="#374151", arrowsize=0.7, penwidth=2];`);
      lines.push(`  bgcolor="transparent";`);
      lines.push(`  margin="0.05";`);
    } else if (style === "compact") {
      // Dense layout for IDE panels/terminals - minimal and monospace
      lines.push(
        `  node [shape=rectangle, style="filled", fontname=monospace, fontsize=7, width=1.0, height=0.5];`
      );
      lines.push(`  edge [color="#6b7280", arrowsize=0.4, style=dotted];`);
      lines.push(`  margin="0";`);
    } else {
      lines.push(`  node [shape=box, style=rounded];`);
      lines.push(`  edge [color=gray];`);
    }

    lines.push("");

    const tasksWithDeps: any[] = [];
    const allTaskIds = new Set<string>();

    // PERFORMANCE OPTIMIZATION: Single bulk query instead of N individual queries
    const taskIds = tasks.map((t) => t.id);
    const allRelationships = await graphService.getRelationshipsForTasks(taskIds);

    // Build dependency maps in memory from single query result
    const dependenciesMap = new Map<string, string[]>();
    const dependentsMap = new Map<string, string[]>();

    allRelationships.forEach(({ fromTaskId, toTaskId }) => {
      if (!dependenciesMap.has(fromTaskId)) dependenciesMap.set(fromTaskId, []);
      dependenciesMap.get(fromTaskId)!.push(toTaskId);

      if (!dependentsMap.has(toTaskId)) dependentsMap.set(toTaskId, []);
      dependentsMap.get(toTaskId)!.push(fromTaskId);

      allTaskIds.add(fromTaskId);
      allTaskIds.add(toTaskId);
    });

    // Filter tasks to only those with actual relationships
    for (const task of tasks) {
      const dependencies = dependenciesMap.get(task.id) || [];
      const dependents = dependentsMap.get(task.id) || [];

      if (dependencies.length > 0 || dependents.length > 0) {
        tasksWithDeps.push({ ...task, dependencies, dependents });
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
          .replace(/"/g, "'")
          .replace(/\n/g, " ")
          .replace(/\r/g, " ");
        const status = task.status || "Unknown";
        const { color, borderColor } = getNodeStyleAttrs(status, style);

        if (["tech-tree", "kanban", "mobile", "compact"].includes(style)) {
          const penwidth = style === "compact" ? "1" : "2";
          lines.push(
            `  ${safeId} [label="${taskId}\\n${title}", fillcolor="${color}", color="${borderColor}", penwidth=${penwidth}];`
          );
        } else {
          lines.push(
            `  ${safeId} [label="${taskId}\\n${title}", fillcolor="${color}", style=filled];`
          );
        }
      } else {
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
    lines.push(`  error [label="Error: ${getErrorMessage(error)}", color=red];`);
    lines.push("}");
    return lines.join("\n");
  }
}

/**
 * Render Graphviz DOT format to SVG, PNG, or PDF using pure JS/WASM
 */
export async function renderGraphvizFormat(
  graphService: TaskGraphService,
  taskService: any,
  limit: number,
  statusFilter: string | undefined,
  format: "svg" | "png" | "pdf",
  outputPath?: string,
  layoutOptions: LayoutOptions = {},
  openFile: boolean = false
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

    // Generate unique output filename if not provided
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "").replace(/T/, "T");
    const randomSuffix = Math.random().toString(36).substring(2, 5);
    const defaultFilename = `task-deps-${timestamp}-${randomSuffix}.${format}`;
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

      // Optionally open the file
      if (openFile) {
        try {
          const openCommand =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          await execAsync(`${openCommand} "${finalOutputPath}"`);
          return {
            message: `✅ Rendered task dependency graph to: ${finalOutputPath} (opened in default application)`,
            filePath: finalOutputPath,
          };
        } catch (error) {
          return {
            message: `✅ Rendered task dependency graph to: ${finalOutputPath} (failed to open: ${getErrorMessage(error)})`,
            filePath: finalOutputPath,
          };
        }
      }

      return {
        message: `✅ Rendered task dependency graph to: ${finalOutputPath}`,
        filePath: finalOutputPath,
      };
    } catch (error) {
      return {
        message: `❌ Failed to render graph: ${getErrorMessage(error)}`,
        filePath: "",
      };
    }
  } catch (error) {
    return {
      message: `❌ Error generating graph: ${getErrorMessage(error)}`,
      filePath: "",
    };
  }
}
