/**
 * Command Registry Tests
 *
 * Comprehensive test suite for the command registry implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";
import {
  SharedCommandRegistry,
  CommandDefinition,
  createSharedCommandRegistry,
  CommandCategory,
} from "./command-registry.js";
import { MinskyError } from "../../errors/index.js";

describe("SharedCommandRegistry", () => {
  let registry: SharedCommandRegistry;

  beforeEach(() => {
    registry = createSharedCommandRegistry();
  });

  describe("Command Registration", () => {
    it("should register a command without type casting", () => {
      const testCommand: CommandDefinition = {
        id: "test-command",
        category: CommandCategory.DEBUG,
        name: "Test Command",
        description: "A test command for validation",
        parameters: {
          message: {
            schema: z.string(),
            description: "Test message",
            required: true,
          },
          count: {
            schema: z.number().int().positive(),
            description: "Number of iterations",
            required: false,
            defaultValue: 1,
          },
        },
        execute: async (params, context) => {
          return {
            message: params.message,
            count: params.count,
            interface: context.interface,
          };
        },
      };

      expect(() => registry.registerCommand(testCommand)).not.toThrow();
      expect(registry.hasCommand("test-command")).toBe(true);
    });

    it("should preserve type information in registered commands", () => {
      const testCommand: CommandDefinition = {
        id: "typed-command",
        category: CommandCategory.CORE,
        name: "Typed Command",
        description: "Command with strong typing",
        parameters: {
          flag: {
            schema: z.boolean(),
            description: "Boolean flag",
            required: true,
          },
          options: {
            schema: z.array(z.string()),
            description: "Array of options",
            required: false,
            defaultValue: [],
          },
        },
        execute: async (params, context) => {
          // TypeScript should infer correct types here
          const flag: boolean = params.flag;
          const options: string[] = params.options || [];
          
          return {
            flag,
            optionCount: options.length,
            debug: context.debug,
          };
        },
      };

      registry.registerCommand(testCommand);
      const retrieved = registry.getCommand("typed-command");
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe("typed-command");
      expect(retrieved?.parameters.flag.schema).toBeDefined();
    });

    it("should throw error when registering duplicate command without allowOverwrite", () => {
      const command1: CommandDefinition = {
        id: "duplicate-test",
        category: CommandCategory.DEBUG,
        name: "First Command",
        description: "First version",
        parameters: {},
        execute: async () => ({ version: 1 }),
      };

      const command2: CommandDefinition = {
        id: "duplicate-test",
        category: CommandCategory.DEBUG,
        name: "Second Command", 
        description: "Second version",
        parameters: {},
        execute: async () => ({ version: 2 }),
      };

      registry.registerCommand(command1);
      
      expect(() => registry.registerCommand(command2)).toThrow(MinskyError);
      expect(() => registry.registerCommand(command2)).toThrow("already registered");
    });

    it("should allow overwrite when allowOverwrite is true", () => {
      const command1: CommandDefinition = {
        id: "overwrite-test",
        category: CommandCategory.DEBUG,
        name: "First Command",
        description: "First version",
        parameters: {},
        execute: async () => ({ version: 1 }),
      };

      const command2: CommandDefinition = {
        id: "overwrite-test",
        category: CommandCategory.DEBUG,
        name: "Second Command",
        description: "Second version", 
        parameters: {},
        execute: async () => ({ version: 2 }),
      };

      registry.registerCommand(command1);
      expect(() => registry.registerCommand(command2, { allowOverwrite: true })).not.toThrow();
      
      const retrieved = registry.getCommand("overwrite-test");
      expect(retrieved?.name).toBe("Second Command");
    });
  });

  describe("Command Retrieval", () => {
    it("should retrieve commands by ID with correct types", () => {
      const sessionCommand: CommandDefinition = {
        id: "session-list",
        category: CommandCategory.SESSION,
        name: "List Sessions",
        description: "List all sessions",
        parameters: {
          repo: {
            schema: z.string(),
            description: "Repository path",
            required: false,
          },
        },
        execute: async (params) => {
          return { sessions: [], repo: params.repo };
        },
      };

      registry.registerCommand(sessionCommand);
      
      const retrieved = registry.getCommand("session-list");
      expect(retrieved).toBeDefined();
      expect(retrieved?.category).toBe(CommandCategory.SESSION);
      expect(retrieved?.parameters.repo).toBeDefined();
    });

    it("should return undefined for non-existent commands", () => {
      const retrieved = registry.getCommand("non-existent");
      expect(retrieved).toBeUndefined();
    });

    it("should retrieve commands by category", () => {
      const gitCommand: CommandDefinition = {
        id: "git-status",
        category: CommandCategory.GIT,
        name: "Git Status",
        description: "Get git status",
        parameters: {},
        execute: async () => ({ status: "clean" }),
      };

      const taskCommand: CommandDefinition = {
        id: "task-list",
        category: CommandCategory.TASKS,
        name: "List Tasks",
        description: "List all tasks",
        parameters: {},
        execute: async () => ({ tasks: [] }),
      };

      registry.registerCommand(gitCommand);
      registry.registerCommand(taskCommand);

      const gitCommands = registry.getCommandsByCategory(CommandCategory.GIT);
      const taskCommands = registry.getCommandsByCategory(CommandCategory.TASKS);

      expect(gitCommands).toHaveLength(1);
      expect(gitCommands[0].id).toBe("git-status");
      expect(taskCommands).toHaveLength(1);
      expect(taskCommands[0].id).toBe("task-list");
    });

    it("should retrieve all commands", () => {
      const commands = [
        {
          id: "cmd1",
          category: CommandCategory.CORE,
          name: "Command 1",
          description: "First command",
          parameters: {},
          execute: async () => ({}),
        },
        {
          id: "cmd2", 
          category: CommandCategory.DEBUG,
          name: "Command 2",
          description: "Second command",
          parameters: {},
          execute: async () => ({}),
        },
      ] as CommandDefinition[];

      commands.forEach(cmd => registry.registerCommand(cmd));

      const allCommands = registry.getAllCommands();
      expect(allCommands).toHaveLength(2);
      expect(allCommands.map(cmd => cmd.id)).toContain("cmd1");
      expect(allCommands.map(cmd => cmd.id)).toContain("cmd2");
    });
  });

  describe("Type Safety Validation", () => {
    it("should maintain parameter type information through execution", async () => {
      const mathCommand: CommandDefinition = {
        id: "math-command",
        category: CommandCategory.CORE,
        name: "Math Command",
        description: "Performs mathematical operations",
        parameters: {
          x: {
            schema: z.number(),
            description: "First number",
            required: true,
          },
          y: {
            schema: z.number(),
            description: "Second number", 
            required: true,
          },
          operation: {
            schema: z.enum(["add", "subtract", "multiply"]),
            description: "Mathematical operation",
            required: false,
            defaultValue: "add" as const,
          },
        },
        execute: async (params, context) => {
          // TypeScript should provide full type checking here
          const { x, y, operation } = params;
          
          let result: number;
          switch (operation) {
          case "add":
            result = x + y;
            break;
          case "subtract":
            result = x - y;
            break;
          case "multiply":
            result = x * y;
            break;
          default:
            result = 0;
          }
          
          return {
            x,
            y,
            operation,
            result,
            executedBy: context.interface,
          };
        },
      };

      registry.registerCommand(mathCommand);
      const command = registry.getCommand("math-command");
      
      expect(command).toBeDefined();
      
      // Simulate execution with proper types
      const result = await command!.execute(
        { x: 5, y: 3, operation: "multiply" },
        { interface: "test", debug: false }
      );
      
      expect(result.result).toBe(15);
      expect(result.operation).toBe("multiply");
    });
  });

  describe("Registry Management", () => {
    it("should report correct command count", () => {
      expect(registry.getCommandCount()).toBe(0);
      
      registry.registerCommand({
        id: "test1",
        category: CommandCategory.DEBUG,
        name: "Test 1",
        description: "Test command 1",
        parameters: {},
        execute: async () => ({}),
      });
      
      expect(registry.getCommandCount()).toBe(1);
      
      registry.registerCommand({
        id: "test2",
        category: CommandCategory.DEBUG,
        name: "Test 2",
        description: "Test command 2",
        parameters: {},
        execute: async () => ({}),
      });
      
      expect(registry.getCommandCount()).toBe(2);
    });

    it("should check command existence", () => {
      expect(registry.hasCommand("test-exists")).toBe(false);
      
      registry.registerCommand({
        id: "test-exists",
        category: CommandCategory.DEBUG,
        name: "Exists Test",
        description: "Test for existence",
        parameters: {},
        execute: async () => ({}),
      });
      
      expect(registry.hasCommand("test-exists")).toBe(true);
    });

    it("should clear all commands", () => {
      registry.registerCommand({
        id: "clear-test",
        category: CommandCategory.DEBUG,
        name: "Clear Test",
        description: "Test clearing",
        parameters: {},
        execute: async () => ({}),
      });
      
      expect(registry.getCommandCount()).toBe(1);
      registry.clear();
      expect(registry.getCommandCount()).toBe(0);
      expect(registry.hasCommand("clear-test")).toBe(false);
    });
  });
}); 
