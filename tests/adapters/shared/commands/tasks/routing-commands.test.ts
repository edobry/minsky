import { describe, expect, test } from "bun:test";
import { createTasksAvailableCommand, createTasksRouteCommand } from "../../../../../src/adapters/shared/commands/tasks/routing-commands";

// Note: Integration tests for routing commands require complex database mocking
// Core functionality is tested in task-routing-service.test.ts
// CLI integration is verified through direct CLI implementations

describe("Routing Commands", () => {
  describe("createTasksAvailableCommand", () => {
    test("creates command with correct structure", () => {
      const command = createTasksAvailableCommand();
      
      expect(command.id).toBe("tasks.available");
      expect(command.name).toBe("available");
      expect(command.description).toContain("available to work on");
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeInstanceOf(Function);
    });

    test("has correct parameter definitions", () => {
      const command = createTasksAvailableCommand();
      const params = command.parameters;
      
      expect(params.status).toBeDefined();
      expect(params.backend).toBeDefined();
      expect(params.limit).toBeDefined();
      expect(params.json).toBeDefined();
      expect(params.minReadiness).toBeDefined();
      
      // Check parameter requirements
      expect(params.status.required).toBe(false);
      expect(params.backend.required).toBe(false);
      expect(params.limit.required).toBe(false);
    });

    // Integration tests require database setup - tested via direct CLI implementations
  });

  describe("createTasksRouteCommand", () => {
    test("creates command with correct structure", () => {
      const command = createTasksRouteCommand();
      
      expect(command.id).toBe("tasks.route");
      expect(command.name).toBe("route");
      expect(command.description).toContain("route to target task");
      expect(command.parameters).toBeDefined();
      expect(command.execute).toBeInstanceOf(Function);
    });

    test("has correct parameter definitions", () => {
      const command = createTasksRouteCommand();
      const params = command.parameters;
      
      expect(params.target).toBeDefined();
      expect(params.strategy).toBeDefined();
      expect(params.parallel).toBeDefined();
      expect(params.json).toBeDefined();
      
      // Check parameter requirements
      expect(params.target.required).toBe(true);
      expect(params.strategy.required).toBe(false);
    });

    // Integration tests require database setup - tested via direct CLI implementations
  });
});
