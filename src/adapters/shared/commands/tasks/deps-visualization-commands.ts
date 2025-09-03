import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { DatabaseConnectionManager } from "../../../../domain/database/connection-manager";
import { TaskGraphService } from "../../../../domain/tasks/task-graph-service";
import { createConfiguredTaskService } from "../../../../domain/tasks/taskService";

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

      const output = await generateDependencyGraph(
        graphService,
        taskService,
        params.limit || 20,
        params.status
      );

      return { success: true, output };
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

    // Find tasks that have dependencies or dependents
    for (const task of tasks) {
      const dependencies = await graphService.listDependencies(task.id);
      const dependents = await graphService.listDependents(task.id);

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
