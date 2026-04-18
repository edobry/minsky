/**
 * Graphviz Dependency Rendering
 *
 * Generates Graphviz DOT format and renders it to SVG/PNG/PDF using
 * pure JS/WASM via @hpcc-js/wasm.
 */

import { writeFileSync } from "fs";
import { execAsync } from "../../../../utils/exec";
import { join } from "path";
import { Graphviz } from "@hpcc-js/wasm";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { type TaskServiceInterface } from "../../../../domain/tasks/taskService";
import { type Task } from "../../../../domain/tasks/types";
import { getErrorMessage } from "../../../../errors/index";
import type { LayoutOptions, TaskNode } from "./deps-rendering-types";

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
  taskService: TaskServiceInterface,
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

    const tasksWithDeps: TaskNode[] = [];
    const allTaskIds = new Set<string>();

    // PERFORMANCE OPTIMIZATION: Single bulk query instead of N individual queries
    const taskIds = tasks.map((t) => t.id);
    const allRelationships = await graphService.getRelationshipsForTasks(taskIds, "depends");

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
    const taskDetailsMap = new Map<string, Task | null>();
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
  taskService: TaskServiceInterface,
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
