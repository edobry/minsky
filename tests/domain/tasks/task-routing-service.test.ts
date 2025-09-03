import { describe, expect, test, beforeEach } from "bun:test";
import {
  TaskRoutingService,
  type AvailableTask,
} from "../../../src/domain/tasks/task-routing-service";
import type { TaskGraphService } from "../../../src/domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "../../../src/domain/tasks/taskService";

// Mock implementations
const mockTaskGraphService: TaskGraphService = {
  getRelationshipsForTasks: async (taskIds: string[]) => {
    // Mock relationships for testing
    const relationships = [
      { fromTaskId: "task-b", toTaskId: "task-a" }, // task-b depends on task-a
      { fromTaskId: "task-c", toTaskId: "task-a" }, // task-c depends on task-a
      { fromTaskId: "task-d", toTaskId: "task-b" }, // task-d depends on task-b
      { fromTaskId: "task-d", toTaskId: "task-c" }, // task-d depends on task-c (parallel path)
    ];
    return relationships.filter((rel) => taskIds.includes(rel.fromTaskId));
  },
  listDependencies: async (taskId: string): Promise<string[]> => {
    const depMap: Record<string, string[]> = {
      "task-a": [],
      "task-b": ["task-a"],
      "task-c": ["task-a"],
      "task-d": ["task-b", "task-c"],
    };
    return depMap[taskId] || [];
  },
  listDependents: async () => [],
  addDependency: async () => {},
  removeDependency: async () => {},
  getAllRelationships: async () => [],
} as any;

const mockTaskService: TaskServiceInterface = {
  listTasks: async (params?: any) => {
    const allTasks = [
      { id: "task-a", title: "Foundation Task A", status: "DONE" },
      { id: "task-b", title: "Intermediate Task B", status: "TODO" },
      { id: "task-c", title: "Parallel Task C", status: "TODO" },
      { id: "task-d", title: "Target Task D", status: "TODO" },
      { id: "task-e", title: "Independent Task E", status: "TODO" },
      { id: "task-f", title: "Completed Task F", status: "DONE" },
      { id: "task-g", title: "Cancelled Task G", status: "CANCELLED" },
    ];

    if (params?.status) {
      return allTasks.filter((task) => task.status === params.status);
    }

    return allTasks;
  },
  getTask: async (taskId: string) => {
    const tasks = await mockTaskService.listTasks();
    return tasks.find((task) => task.id === taskId) || null;
  },
} as any;

describe("TaskRoutingService", () => {
  let routingService: TaskRoutingService;

  beforeEach(() => {
    routingService = new TaskRoutingService(mockTaskGraphService, mockTaskService);
  });

  describe("findAvailableTasks", () => {
    test("identifies fully available tasks with no dependencies", async () => {
      const availableTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 10,
      });

      // task-e should be fully available (no dependencies)
      const independentTask = availableTasks.find((task) => task.taskId === "task-e");
      expect(independentTask).toBeDefined();
      expect(independentTask!.readinessScore).toBe(1.0);
      expect(independentTask!.blockedBy).toEqual([]);
    });

    test("calculates partial readiness for tasks with mixed dependencies", async () => {
      const availableTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 10,
      });

      // task-b depends on task-a (which is DONE) - should be 100% ready
      const taskB = availableTasks.find((task) => task.taskId === "task-b");
      expect(taskB).toBeDefined();
      expect(taskB!.readinessScore).toBe(1.0);
      expect(taskB!.blockedBy).toEqual([]);

      // task-c depends on task-a (which is DONE) - should be 100% ready
      const taskC = availableTasks.find((task) => task.taskId === "task-c");
      expect(taskC).toBeDefined();
      expect(taskC!.readinessScore).toBe(1.0);
      expect(taskC!.blockedBy).toEqual([]);
    });

    test("identifies blocked tasks with pending dependencies", async () => {
      const availableTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 10,
      });

      // task-d depends on task-b and task-c (both TODO) - should have blockers
      const taskD = availableTasks.find((task) => task.taskId === "task-d");
      expect(taskD).toBeDefined();
      expect(taskD!.readinessScore).toBe(0.0); // Both dependencies are pending
      expect(taskD!.blockedBy).toContain("task-b");
      expect(taskD!.blockedBy).toContain("task-c");
    });

    test("filters tasks by status correctly", async () => {
      const todoTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 10,
      });

      const doneTasks = await routingService.findAvailableTasks({
        statusFilter: ["DONE"],
        limit: 10,
      });

      // Should have TODO tasks
      expect(todoTasks.length).toBeGreaterThan(0);
      expect(todoTasks.every((task) => task.status === "TODO")).toBe(true);

      // Should have DONE tasks
      expect(doneTasks.length).toBeGreaterThan(0);
      expect(doneTasks.every((task) => task.status === "DONE")).toBe(true);
    });

    test("sorts tasks by readiness score", async () => {
      const availableTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 10,
      });

      // Should be sorted by readiness score descending
      for (let i = 1; i < availableTasks.length; i++) {
        expect(availableTasks[i - 1].readinessScore).toBeGreaterThanOrEqual(
          availableTasks[i].readinessScore
        );
      }
    });

    test("respects limit parameter", async () => {
      const limitedTasks = await routingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 2,
      });

      expect(limitedTasks.length).toBeLessThanOrEqual(2);
    });

    test("handles backend filtering", async () => {
      // Add mt# prefixed task to mock
      const mockWithMtTasks = {
        ...mockTaskService,
        listTasks: async (params?: any) => {
          const allTasks = [
            { id: "mt#123", title: "Minsky Task 123", status: "TODO" },
            { id: "md#456", title: "Markdown Task 456", status: "TODO" },
            { id: "gh#789", title: "GitHub Task 789", status: "TODO" },
          ];

          if (params?.status) {
            return allTasks.filter((task) => task.status === params.status);
          }

          return allTasks;
        },
      } as any;

      const mtRoutingService = new TaskRoutingService(mockTaskGraphService, mockWithMtTasks);

      const availableTasks = await mtRoutingService.findAvailableTasks({
        statusFilter: ["TODO"],
        backendFilter: "mt#",
        limit: 10,
      });

      // Should only include mt# tasks
      expect(availableTasks.length).toBeGreaterThan(0);
      expect(availableTasks.every((task) => task.taskId.startsWith("mt#"))).toBe(true);
    });
  });

  describe("generateRoute", () => {
    test("generates route to task with dependencies", async () => {
      const route = await routingService.generateRoute("task-d", "ready-first");

      expect(route.targetTaskId).toBe("task-d");
      expect(route.targetTitle).toBe("Target Task D");
      expect(route.strategy).toBe("ready-first");
      expect(route.totalTasks).toBeGreaterThan(1); // Should include dependencies

      // Should include the target task and its dependencies
      const stepIds = route.steps.map((step) => step.taskId);
      expect(stepIds).toContain("task-d");
      expect(stepIds).toContain("task-b");
      expect(stepIds).toContain("task-c");
      expect(stepIds).toContain("task-a");
    });

    test("handles task with no dependencies", async () => {
      const route = await routingService.generateRoute("task-e", "ready-first");

      expect(route.targetTaskId).toBe("task-e");
      expect(route.totalTasks).toBe(1); // Only the target task
      expect(route.readyTasks).toBe(1);
      expect(route.blockedTasks).toBe(0);
    });

    test("assigns correct depth values to route steps", async () => {
      const route = await routingService.generateRoute("task-d", "ready-first");

      // task-a should be deepest (foundation)
      const stepA = route.steps.find((step) => step.taskId === "task-a");
      expect(stepA).toBeDefined();
      expect(stepA!.depth).toBe(2); // Deepest dependency

      // task-b and task-c should be intermediate
      const stepB = route.steps.find((step) => step.taskId === "task-b");
      const stepC = route.steps.find((step) => step.taskId === "task-c");
      expect(stepB!.depth).toBe(1);
      expect(stepC!.depth).toBe(1);

      // task-d should be the target (depth 0)
      const stepD = route.steps.find((step) => step.taskId === "task-d");
      expect(stepD!.depth).toBe(0);
    });

    test("throws error for non-existent target task", async () => {
      expect(async () => {
        await routingService.generateRoute("non-existent", "ready-first");
      }).toThrow("Target task non-existent not found");
    });

    test("calculates ready vs blocked task counts correctly", async () => {
      const route = await routingService.generateRoute("task-d", "ready-first");

      // task-a is DONE, so task-b and task-c should be ready
      // task-d should be blocked by task-b and task-c
      expect(route.readyTasks).toBeGreaterThan(0);
      expect(route.blockedTasks).toBeGreaterThan(0);
      expect(route.readyTasks + route.blockedTasks).toBe(route.totalTasks);
    });

    test("applies different routing strategies", async () => {
      const readyFirstRoute = await routingService.generateRoute("task-d", "ready-first");
      const shortestPathRoute = await routingService.generateRoute("task-d", "shortest-path");

      expect(readyFirstRoute.strategy).toBe("ready-first");
      expect(shortestPathRoute.strategy).toBe("shortest-path");

      // Both should have same target and total tasks, but potentially different ordering
      expect(readyFirstRoute.targetTaskId).toBe(shortestPathRoute.targetTaskId);
      expect(readyFirstRoute.totalTasks).toBe(shortestPathRoute.totalTasks);
    });
  });

  describe("performance", () => {
    test("uses bulk queries for efficient database access", async () => {
      let getRelationshipsCallCount = 0;
      let listDependenciesCallCount = 0;

      const mockGraphService = {
        ...mockTaskGraphService,
        getRelationshipsForTasks: async (taskIds: string[]) => {
          getRelationshipsCallCount++;
          return mockTaskGraphService.getRelationshipsForTasks(taskIds);
        },
        listDependencies: async (taskId: string) => {
          listDependenciesCallCount++;
          return mockTaskGraphService.listDependencies(taskId);
        },
      } as any;

      const perfRoutingService = new TaskRoutingService(mockGraphService, mockTaskService);

      // Test findAvailableTasks with multiple tasks
      await perfRoutingService.findAvailableTasks({
        statusFilter: ["TODO"],
        limit: 5,
      });

      // Should use bulk query (1 call) instead of N individual calls
      expect(getRelationshipsCallCount).toBe(1);
      expect(listDependenciesCallCount).toBeLessThan(5); // Should be minimal
    });
  });

  describe("edge cases", () => {
    test("handles empty task list gracefully", async () => {
      const emptyTaskService = {
        listTasks: async () => [],
        getTask: async () => null,
      } as any;

      const emptyRoutingService = new TaskRoutingService(mockTaskGraphService, emptyTaskService);
      const availableTasks = await emptyRoutingService.findAvailableTasks();

      expect(availableTasks).toEqual([]);
    });

    test("handles tasks with missing dependency references", async () => {
      const mockWithMissingDeps = {
        ...mockTaskGraphService,
        getRelationshipsForTasks: async () => [
          { fromTaskId: "task-x", toTaskId: "non-existent-task" },
        ],
      } as any;

      const mockServiceWithX = {
        ...mockTaskService,
        listTasks: async () => [{ id: "task-x", title: "Task with missing dep", status: "TODO" }],
        getTask: async (id: string) => {
          if (id === "task-x")
            return { id: "task-x", title: "Task with missing dep", status: "TODO" };
          return null; // non-existent-task returns null
        },
      } as any;

      const routingService = new TaskRoutingService(mockWithMissingDeps, mockServiceWithX);
      const availableTasks = await routingService.findAvailableTasks();

      // Should handle missing dependencies gracefully
      expect(availableTasks.length).toBe(1);
      expect(availableTasks[0].taskId).toBe("task-x");
      expect(availableTasks[0].readinessScore).toBe(1.0); // Should be ready since dep doesn't exist
    });

    test("handles circular dependency detection in route generation", async () => {
      const circularGraphService = {
        ...mockTaskGraphService,
        listDependencies: async (taskId: string): Promise<string[]> => {
          // Create a circular dependency: task-x -> task-y -> task-x
          if (taskId === "task-x") return ["task-y"];
          if (taskId === "task-y") return ["task-x"];
          return [];
        },
      } as any;

      const circularTaskService = {
        ...mockTaskService,
        getTask: async (id: string) => {
          if (id === "task-x") return { id: "task-x", title: "Circular Task X", status: "TODO" };
          if (id === "task-y") return { id: "task-y", title: "Circular Task Y", status: "TODO" };
          return null;
        },
      } as any;

      const circularRoutingService = new TaskRoutingService(
        circularGraphService,
        circularTaskService
      );

      // This should not hang due to infinite recursion
      const route = await circularRoutingService.generateRoute("task-x", "ready-first");
      expect(route).toBeDefined();
      expect(route.totalTasks).toBeGreaterThan(0);
    });
  });
});
