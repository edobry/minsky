import type { TaskGraphService } from "./task-graph-service";
import type { TaskServiceInterface } from "./taskService";

export interface AvailableTask {
  taskId: string;
  title: string;
  status: string;
  readinessScore: number; // 0.0-1.0, where 1.0 = fully ready to start
  blockedBy: string[]; // Array of task IDs blocking this task
  priority?: string;
  effort?: number;
  category?: string;
  backend?: string;
}

export interface RouteStep {
  taskId: string;
  title: string;
  status: string;
  dependencies: string[];
  depth: number;
  isParallel: boolean;
}

export interface TaskRoute {
  targetTaskId: string;
  targetTitle: string;
  strategy: string;
  steps: RouteStep[];
  parallelTracks: RouteStep[][];
  totalTasks: number;
  readyTasks: number;
  blockedTasks: number;
  estimatedEffort?: number;
}

export class TaskRoutingService {
  constructor(
    private taskGraphService: TaskGraphService,
    private taskService: TaskServiceInterface
  ) {}

  /**
   * Find all tasks that are currently available to work on (unblocked by dependencies)
   */
  async findAvailableTasks(options: {
    statusFilter?: string[];
    backendFilter?: string;
    limit?: number;
    showEffort?: boolean;
    showPriority?: boolean;
  } = {}): Promise<AvailableTask[]> {
    const {
      statusFilter = ["TODO", "IN-PROGRESS"],
      backendFilter,
      limit = 50,
    } = options;

    // Get all tasks
    const allTasks = await this.taskService.listTasks({
      status: statusFilter.length === 1 ? statusFilter[0] : undefined,
    });

    // Filter by backend if specified
    const filteredTasks = backendFilter
      ? allTasks.filter((task) => task.id.startsWith(backendFilter))
      : allTasks;

    // Filter by status if multiple statuses specified
    const statusFilteredTasks = statusFilter.length > 1
      ? filteredTasks.filter((task) => statusFilter.includes(task.status))
      : filteredTasks;

    if (statusFilteredTasks.length === 0) {
      return [];
    }

    // Get task IDs for bulk dependency lookup
    const taskIds = statusFilteredTasks.map((task) => task.id);

    // Get all relationships for these tasks in bulk
    const relationships = await this.taskGraphService.getRelationshipsForTasks(taskIds);

    // Build dependency map: taskId -> array of tasks it depends on
    const dependencyMap = new Map<string, string[]>();
    for (const task of statusFilteredTasks) {
      dependencyMap.set(task.id, []);
    }

    for (const rel of relationships) {
      // If task depends on something (rel.fromTaskId → rel.toTaskId means fromTaskId depends on toTaskId)
      if (dependencyMap.has(rel.fromTaskId)) {
        dependencyMap.get(rel.fromTaskId)!.push(rel.toTaskId);
      }
    }

    // Calculate readiness score for each task
    const availableTasks: AvailableTask[] = [];

    for (const task of statusFilteredTasks) {
      const blockedBy = dependencyMap.get(task.id) || [];
      
      // Get status of blocking dependencies
      const blockingTasks = await Promise.all(
        blockedBy.map(async (depId) => {
          try {
            const depTask = await this.taskService.getTask(depId);
            return depTask ? { id: depId, status: depTask.status } : null;
          } catch {
            return null; // Task not found
          }
        })
      );

      // Filter out non-existent dependencies and completed ones
      const actualBlockingTasks = blockingTasks
        .filter((dep) => dep !== null)
        .filter((dep) => dep!.status !== "DONE" && dep!.status !== "CANCELLED");

      // Calculate readiness score (1.0 = no blockers, 0.0 = all blockers pending)
      const totalDeps = blockedBy.length;
      const completedDeps = totalDeps - actualBlockingTasks.length;
      const readinessScore = totalDeps === 0 ? 1.0 : completedDeps / totalDeps;

      const availableTask: AvailableTask = {
        taskId: task.id,
        title: task.title || "Unknown",
        status: task.status,
        readinessScore,
        blockedBy: actualBlockingTasks.map((dep) => dep!.id),
        backend: task.id.includes("#") ? task.id.split("#")[0] : undefined,
        // TODO: Add priority and effort when available in task metadata
      };

      availableTasks.push(availableTask);
    }

    // Sort by readiness score (highest first), then by number of blockers (fewest first)
    availableTasks.sort((a, b) => {
      if (a.readinessScore !== b.readinessScore) {
        return b.readinessScore - a.readinessScore;
      }
      return a.blockedBy.length - b.blockedBy.length;
    });

    return availableTasks.slice(0, limit);
  }

  /**
   * Generate a route to a target task using dependency analysis
   */
  async generateRoute(
    targetTaskId: string,
    strategy: "shortest-path" | "value-first" | "ready-first" = "ready-first"
  ): Promise<TaskRoute> {
    // Get the target task
    const targetTask = await this.taskService.getTask(targetTaskId);
    if (!targetTask) {
      throw new Error(`Target task ${targetTaskId} not found`);
    }

    // Find all dependencies leading to target (breadth-first traversal)
    const allDependencies = await this._findAllDependencies(targetTaskId, new Set());
    
    // Get task details for all dependencies
    const taskDetails = await Promise.all(
      Array.from(allDependencies).map(async (taskId) => {
        try {
          const task = await this.taskService.getTask(taskId);
          return task ? { id: taskId, ...task } : null;
        } catch {
          return null;
        }
      })
    );

    const validTasks = taskDetails.filter((task) => task !== null);

    // Build route steps with dependency information
    const steps: RouteStep[] = [];
    const visitedDepths = new Map<string, number>();

    // Calculate depth for each task (distance from target)
    await this._calculateDepths(targetTaskId, 0, visitedDepths);

    for (const task of validTasks) {
      const dependencies = await this.taskGraphService.listDependencies(task.id);
      
      steps.push({
        taskId: task.id,
        title: task.title || "Unknown",
        status: task.status,
        dependencies,
        depth: visitedDepths.get(task.id) || 0,
        isParallel: false, // TODO: Implement parallel detection
      });
    }

    // Sort steps by strategy
    if (strategy === "ready-first") {
      steps.sort((a, b) => {
        // Prioritize tasks with all dependencies completed
        const aReady = a.dependencies.every(depId => {
          const depTask = validTasks.find(t => t.id === depId);
          return depTask?.status === "DONE" || depTask?.status === "CANCELLED";
        });
        const bReady = b.dependencies.every(depId => {
          const depTask = validTasks.find(t => t.id === depId);
          return depTask?.status === "DONE" || depTask?.status === "CANCELLED";
        });
        
        if (aReady !== bReady) return bReady ? 1 : -1;
        
        // Then by depth (foundation tasks first)
        return b.depth - a.depth;
      });
    }

    // Calculate summary statistics
    const readyTasks = steps.filter(step => 
      step.dependencies.every(depId => {
        const depTask = validTasks.find(t => t.id === depId);
        return depTask?.status === "DONE" || depTask?.status === "CANCELLED";
      })
    ).length;

    const blockedTasks = steps.length - readyTasks;

    return {
      targetTaskId,
      targetTitle: targetTask.title || "Unknown",
      strategy,
      steps,
      parallelTracks: [], // TODO: Implement parallel track detection
      totalTasks: steps.length,
      readyTasks,
      blockedTasks,
    };
  }

  /**
   * Find all dependencies of a task recursively
   */
  private async _findAllDependencies(taskId: string, visited: Set<string>): Promise<Set<string>> {
    if (visited.has(taskId)) {
      return visited;
    }

    visited.add(taskId);
    const dependencies = await this.taskGraphService.listDependencies(taskId);
    
    for (const depId of dependencies) {
      await this._findAllDependencies(depId, visited);
    }

    return visited;
  }

  /**
   * Calculate depth of each task from target (reverse BFS)
   */
  private async _calculateDepths(taskId: string, depth: number, depths: Map<string, number>): Promise<void> {
    if (depths.has(taskId) && depths.get(taskId)! <= depth) {
      return; // Already processed with shorter or equal depth
    }

    depths.set(taskId, depth);
    const dependencies = await this.taskGraphService.listDependencies(taskId);
    
    for (const depId of dependencies) {
      await this._calculateDepths(depId, depth + 1, depths);
    }
  }
}
