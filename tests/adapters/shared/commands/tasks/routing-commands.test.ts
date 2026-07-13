import { describe, expect, test } from "bun:test";
import {
  createTasksAvailableCommand,
  createTasksRouteCommand,
} from "../../../../../src/adapters/shared/commands/tasks/routing-commands";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
import type { TaskRoutingService } from "@minsky/domain/tasks/task-routing-service";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

// Note: Integration tests for routing commands require complex database mocking
// Core functionality is tested in task-routing-service.test.ts
// CLI integration is verified through direct CLI implementations

const stubGetProvider = () => ({}) as PersistenceProvider;
const stubGetRoutingService = () => ({}) as TaskRoutingService;
const stubGetTaskService = () => ({}) as TaskServiceInterface;

describe("Routing Commands", () => {
  describe("createTasksAvailableCommand", () => {
    test("creates command with correct structure", () => {
      const command = createTasksAvailableCommand(
        stubGetProvider,
        stubGetRoutingService,
        stubGetTaskService
      );

      expect(command.id).toBe("tasks.available");
      expect(command.name).toBe("available");
      expect(command.description).toContain("available to work on");
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeInstanceOf(Function);
    });

    test("has correct parameter definitions", () => {
      const command = createTasksAvailableCommand(
        stubGetProvider,
        stubGetRoutingService,
        stubGetTaskService
      );
      const params = command.parameters;

      expect(params.status).toBeDefined();
      expect(params.backend).toBeDefined();
      expect(params.limit).toBeDefined();
      expect(params.json).toBeDefined();
      expect(params.minReadiness).toBeDefined();

      // Check parameter requirements
      expect(params.status?.required).toBe(false);
      expect(params.backend?.required).toBe(false);
      expect(params.limit?.required).toBe(false);
    });

    // Integration tests require database setup - tested via direct CLI implementations

    describe("minReadiness default materialization (mt#2759)", () => {
      // The CLI/MCP bridges materialize omitted-arg defaults ONLY from
      // CommandParameterDefinition.defaultValue — a Zod schema.default() is never
      // parsed at runtime. Guard against the two drifting apart.
      test("declares defaultValue so the bridges apply the documented defaults", () => {
        const command = createTasksAvailableCommand(
          stubGetProvider,
          stubGetRoutingService,
          stubGetTaskService
        );

        expect(command.parameters.minReadiness?.defaultValue).toBe(0.5);
        expect(command.parameters.limit?.defaultValue).toBe(20);
      });

      test("returns fully-ready tasks when minReadiness is omitted entirely", async () => {
        // Mimics what the bridges hand to execute() when the caller omits the
        // param and no defaultValue is materialized: the key is simply absent.
        // Before mt#2759, `readinessScore >= undefined` filtered out every task.
        const providerWithSql = (() =>
          ({ capabilities: { sql: true } }) as unknown as PersistenceProvider)();
        const routingService = {
          findAvailableTasks: async () => [
            {
              taskId: "mt#9999",
              title: "Fully ready task",
              status: "TODO",
              readinessScore: 1.0,
              blockedBy: [],
              backend: "mt",
            },
          ],
        } as unknown as TaskRoutingService;

        const command = createTasksAvailableCommand(
          () => providerWithSql,
          () => routingService,
          stubGetTaskService
        );

        const result = (await command.execute({ json: true } as never)) as {
          success: boolean;
          data?: { availableTasks: unknown[]; count: number };
        };

        expect(result.success).toBe(true);
        expect(result.data?.count).toBe(1);
        expect(result.data?.availableTasks).toHaveLength(1);
      });
    });
  });

  describe("createTasksRouteCommand", () => {
    test("creates command with correct structure", () => {
      const command = createTasksRouteCommand(stubGetProvider, stubGetRoutingService);

      expect(command.id).toBe("tasks.route");
      expect(command.name).toBe("route");
      expect(command.description).toContain("route to target task");
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeInstanceOf(Function);
    });

    test("has correct parameter definitions", () => {
      const command = createTasksRouteCommand(stubGetProvider, stubGetRoutingService);
      const params = command.parameters;

      expect(params.target).toBeDefined();
      expect(params.strategy).toBeDefined();
      expect(params.parallel).toBeDefined();
      expect(params.json).toBeDefined();

      // Check parameter requirements
      expect(params.target?.required).toBe(true);
      expect(params.strategy?.required).toBe(false);
    });

    // Integration tests require database setup - tested via direct CLI implementations
  });
});
