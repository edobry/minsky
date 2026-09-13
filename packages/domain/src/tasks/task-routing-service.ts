import { injectable } from "tsyringe";
import {
  computeAutonomyClass,
  countExcluded,
  emptyExcludedByClass,
  isServableClass,
  type AutonomyClassResult,
  type ExcludedByClass,
  type TaskAutonomyClass,
} from "./autonomy-class";
import type { AutonomySignalSource } from "./autonomy-class-store";
import type { TaskGraphService } from "./task-graph-service";
import type { TaskServiceInterface } from "./taskService";
import type { Task } from "./types";
import { isTerminal } from "./workflows";

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
  /** Computed, never stored (mt#5130). Only `pull-only`/`contained` are ever served. */
  autonomyClass?: TaskAutonomyClass;
}

export interface AvailableTasksResult {
  tasks: AvailableTask[];
  /** How many candidates the class filter excluded, so the exclusion is visible. */
  excludedByClass: ExcludedByClass;
}

export interface RouteStep {
  taskId: string;
  title: string;
  status: string;
  dependencies: string[];
  depth: number;
  isParallel: boolean;
  /** Computed (mt#5130); a principal-gated step is never "ready" work. */
  autonomyClass?: TaskAutonomyClass;
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
  /** The target's own class and why (mt#5130) — a route to a gated target says so. */
  targetAutonomyClass?: TaskAutonomyClass;
  targetAutonomyReasons?: string[];
}

export interface FindAvailableTasksOptions {
  statusFilter?: string[];
  backendFilter?: string;
  /** Filter by workflow kind (mt#2762), forwarded server-side to taskService.listTasks. */
  kind?: string;
  limit?: number;
  showEffort?: boolean;
  showPriority?: boolean;
}

@injectable()
export class TaskRoutingService {
  /**
   * `signalSource` loads the spec sections the autonomy classifier reads, in
   * bulk. Optional so the DI-free construction sites keep working; without it
   * every candidate not gated by its row alone resolves `unknown` and is
   * excluded — the default-deny the RFC asks for, made visible in
   * `excludedByClass` rather than served.
   */
  constructor(
    private taskGraphService: TaskGraphService,
    private taskService: TaskServiceInterface,
    private signalSource?: AutonomySignalSource
  ) {}

  /** Classify a batch of task rows with one bulk signal load. */
  private async classify(tasks: readonly Task[]): Promise<Map<string, AutonomyClassResult>> {
    const signals = this.signalSource
      ? await this.signalSource.loadSpecSignals(tasks.map((t) => t.id))
      : undefined;
    const out = new Map<string, AutonomyClassResult>();
    for (const task of tasks) {
      out.set(
        task.id,
        computeAutonomyClass({
          id: task.id,
          kind: task.kind,
          status: task.status,
          tags: task.tags ?? [],
          title: task.title ?? "",
          spec: signals?.get(task.id),
          humanOrigin: undefined,
        })
      );
    }
    return out;
  }

  /**
   * Find all tasks that are currently available to work on (unblocked by dependencies).
   * Same result as `findAvailableTasksWithClass(...).tasks` — the class filter applies
   * on both, so no caller of the old shape can be served a gated task.
   */
  async findAvailableTasks(options: FindAvailableTasksOptions = {}): Promise<AvailableTask[]> {
    return (await this.findAvailableTasksWithClass(options)).tasks;
  }

  /**
   * `findAvailableTasks` plus the per-class exclusion counts (mt#5130). The
   * class is computed BEFORE the per-task dependency lookup so an excluded
   * candidate costs no extra query.
   */
  async findAvailableTasksWithClass(
    options: FindAvailableTasksOptions = {}
  ): Promise<AvailableTasksResult> {
    const { statusFilter = ["TODO", "IN-PROGRESS"], backendFilter, kind, limit = 50 } = options;

    // Get all tasks
    const listed = await this.taskService.listTasks({
      status: statusFilter.length === 1 ? statusFilter[0] : undefined,
      kind,
    });

    // ADR-046 (mt#2911): a work package is claimed deliberately, never
    // auto-served — the consumer-side default-deny. Excluded whenever the
    // caller did not name a kind; an explicit `kind: "work-package"` filter
    // (or any other explicit kind) bypasses this untouched.
    //
    // Post-fetch filtering cannot underfill here (PR #3503 R1): listTasks is
    // UNBOUNDED — minskyTaskBackend.listTasks issues no LIMIT — and this
    // method's own `limit` applies at the final slice, after this filter. If
    // listTasks ever gains server-side limiting, push this exclusion into the
    // query (an excludeKinds option) rather than keeping it post-fetch.
    const allTasks = kind ? listed : listed.filter((task) => task.kind !== "work-package");

    // Filter by backend if specified
    const filteredTasks = backendFilter
      ? allTasks.filter((task) => task.id.startsWith(backendFilter))
      : allTasks;

    // Filter by status if multiple statuses specified
    const statusFiltered =
      statusFilter.length > 1
        ? filteredTasks.filter((task) => statusFilter.includes(task.status))
        : filteredTasks;

    const excludedByClass = emptyExcludedByClass();
    if (statusFiltered.length === 0) {
      return { tasks: [], excludedByClass };
    }

    // Consumer-side default-deny on the computed autonomy class (mt#5130,
    // RFC 3ae937f0): `principal-gated` and `unknown` are never served. Same
    // posture as the work-package exclusion above, one more predicate.
    const classes = await this.classify(statusFiltered);
    const statusFilteredTasks = statusFiltered.filter((task) => {
      const cls = classes.get(task.id)?.class ?? "unknown";
      if (isServableClass(cls)) return true;
      countExcluded(excludedByClass, cls);
      return false;
    });
    if (statusFilteredTasks.length === 0) {
      return { tasks: [], excludedByClass };
    }

    // Get task IDs for bulk dependency lookup
    const taskIds = statusFilteredTasks.map((task) => task.id);

    // Get all relationships for these tasks in bulk
    const relationships = await this.taskGraphService.getRelationshipsForTasks(taskIds, "depends");

    // Build dependency map: taskId -> array of tasks it depends on
    const dependencyMap = new Map<string, string[]>();
    for (const task of statusFilteredTasks) {
      dependencyMap.set(task.id, []);
    }

    for (const rel of relationships) {
      // If task depends on something (rel.fromTaskId → rel.toTaskId means fromTaskId depends on toTaskId)
      if (dependencyMap.has(rel.fromTaskId)) {
        dependencyMap.get(rel.fromTaskId)?.push(rel.toTaskId);
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

      // Filter out non-existent dependencies and completed ones (mt#3010:
      // migrated off the mt#3011 interim TASK_STATUS.DONE/.CLOSED comparison
      // to the registry's terminal predicate).
      const actualBlockingTasks = blockingTasks
        .filter((dep): dep is { id: string; status: string } => dep !== null)
        .filter((dep) => !isTerminal(dep.status));

      // Calculate readiness score (1.0 = no blockers, 0.0 = all blockers pending)
      const totalDeps = blockedBy.length;
      const completedDeps = totalDeps - actualBlockingTasks.length;
      const readinessScore = totalDeps === 0 ? 1.0 : completedDeps / totalDeps;

      const availableTask: AvailableTask = {
        taskId: task.id,
        title: task.title || "Unknown",
        status: task.status,
        readinessScore,
        blockedBy: actualBlockingTasks.map((dep) => dep.id),
        backend: task.id.includes("#") ? task.id.split("#")[0] : undefined,
        autonomyClass: classes.get(task.id)?.class,
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

    return { tasks: availableTasks.slice(0, limit), excludedByClass };
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
          return task ? { ...task, id: taskId } : null;
        } catch {
          return null;
        }
      })
    );

    const validTasks = taskDetails.filter((task) => task !== null);

    // The route is navigation toward a caller-named target, never selection —
    // so nothing is refused here. What it must not do is present a gated task
    // as work to start (mt#5130): every step and the target carry their class,
    // and the ready count below skips the ones a person has to decide on.
    const classes = await this.classify([{ ...targetTask, id: targetTaskId }, ...validTasks]);
    const targetClass = classes.get(targetTaskId);
    const isReadyClass = (id: string): boolean => {
      const cls = classes.get(id)?.class ?? "unknown";
      return isServableClass(cls);
    };

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
        autonomyClass: classes.get(task.id)?.class,
      });
    }

    // Sort steps by strategy
    if (strategy === "ready-first") {
      steps.sort((a, b) => {
        // Prioritize tasks with all dependencies completed
        const aReady = a.dependencies.every((depId) => {
          const depTask = validTasks.find((t) => t.id === depId);
          return isTerminal(depTask?.status);
        });
        const bReady = b.dependencies.every((depId) => {
          const depTask = validTasks.find((t) => t.id === depId);
          return isTerminal(depTask?.status);
        });

        if (aReady !== bReady) return bReady ? 1 : -1;

        // Then by depth (foundation tasks first)
        return b.depth - a.depth;
      });
    }

    // Calculate summary statistics. A step whose class a person must decide on
    // counts as blocked even with every dependency terminal (mt#5130).
    const readyTasks = steps.filter(
      (step) =>
        isReadyClass(step.taskId) &&
        step.dependencies.every((depId) => {
          const depTask = validTasks.find((t) => t.id === depId);
          return isTerminal(depTask?.status);
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
      targetAutonomyClass: targetClass?.class,
      targetAutonomyReasons: targetClass?.reasons,
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
  private async _calculateDepths(
    taskId: string,
    depth: number,
    depths: Map<string, number>
  ): Promise<void> {
    const existingDepth = depths.get(taskId);
    if (existingDepth !== undefined && existingDepth <= depth) {
      return; // Already processed with shorter or equal depth
    }

    depths.set(taskId, depth);
    const dependencies = await this.taskGraphService.listDependencies(taskId);

    for (const depId of dependencies) {
      await this._calculateDepths(depId, depth + 1, depths);
    }
  }
}
