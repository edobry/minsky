import { describe, it, expect, beforeEach } from "bun:test";
import { ToolSchemasComponent } from "./tool-schemas";
import type { ComponentInput } from "./types";
import {
  createSharedCommandRegistry,
  CommandCategory,
} from "../../../adapters/shared/command-registry";
import { registerRulesCommands } from "../../../adapters/shared/commands/rules";

describe("ToolSchemasComponent", () => {
  let testRegistry: ReturnType<typeof createSharedCommandRegistry>;

  beforeEach(async () => {
    // Create a fresh registry for each test to avoid interference
    testRegistry = createSharedCommandRegistry();

    // Register commands that support registry parameters
    registerRulesCommands(testRegistry);

    // Manually register some test commands to ensure we have >10 tools
    for (let i = 1; i <= 15; i++) {
      testRegistry.registerCommand({
        id: `test.command${i}`,
        category: CommandCategory.TASKS,
        name: `Test Command ${i}`,
        description: `Test command ${i} for testing`,
        parameters: {},
        execute: async () => ({ success: true }),
      });
    }
  });

  const mockComponentInput: ComponentInput = {
    environment: { os: "darwin", shell: "/bin/zsh" },
    workspacePath: "/test/workspace",
    userQuery: "test query",
    targetModel: "gpt-4o",
  };

  describe("interface configuration logic", () => {
    it("should detect CLI interface correctly", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "cli",
          mcpEnabled: false,
          preferMcp: false,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("cli");
      expect(gatheredInputs.shouldUseMcp).toBe(false);
    });

    it("should detect MCP interface correctly", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "mcp",
          mcpEnabled: true,
          preferMcp: true,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("mcp");
      expect(gatheredInputs.shouldUseMcp).toBe(true);
    });

    it("should detect hybrid interface with CLI preference", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "hybrid",
          mcpEnabled: true,
          preferMcp: false,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("hybrid");
      expect(gatheredInputs.shouldUseMcp).toBe(false);
    });

    it("should detect hybrid interface with MCP preference", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "hybrid",
          mcpEnabled: true,
          preferMcp: true,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("hybrid");
      expect(gatheredInputs.shouldUseMcp).toBe(true);
    });

    it("should default to CLI when no interfaceConfig provided", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        // No interfaceConfig provided
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("cli");
      expect(gatheredInputs.shouldUseMcp).toBe(false);
    });
  });

  describe("output format rendering", () => {
    it("should render JSON format for CLI interface", () => {
      const mockInputs = {
        toolSchemas: { "test.command": { description: "Test command", parameters: {} } },
        totalTools: 1,
        interfaceMode: "cli",
        shouldUseMcp: false,
      };

      const result = ToolSchemasComponent.render(mockInputs, mockComponentInput);

      expect(result.content).toInclude("Here are the functions available in JSONSchema format:");
      expect(result.content).toInclude("test.command");
      expect(result.content).not.toInclude("<functions>");
    });

    it("should render XML format for MCP interface", () => {
      const mockInputs = {
        toolSchemas: { "test.command": { description: "Test command", parameters: {} } },
        totalTools: 1,
        interfaceMode: "mcp",
        shouldUseMcp: true,
      };

      const result = ToolSchemasComponent.render(mockInputs, mockComponentInput);

      expect(result.content).toInclude("Here are the functions available in JSONSchema format:");
      expect(result.content).toInclude("<functions>");
      expect(result.content).toInclude("<function>");
      expect(result.content).toInclude('"name": "test.command"');
    });
  });

  describe("component metadata", () => {
    it("should include proper metadata in output", () => {
      const mockInputs = {
        toolSchemas: { "test.command": { description: "Test command", parameters: {} } },
        totalTools: 1,
        interfaceMode: "cli",
        shouldUseMcp: false,
      };

      const result = ToolSchemasComponent.render(mockInputs, mockComponentInput);

      expect(result.metadata.componentId).toBe("tool-schemas");
      expect(result.metadata.sections).toEqual(["functions"]);
      expect(result.metadata.totalTools).toBe(1);
      expect(result.metadata.tokenCount).toBeGreaterThan(0);
    });
  });

  describe("parameter schema generation", () => {
    it("should generate rich parameter schemas from shared command registry", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "cli",
          mcpEnabled: false,
          preferMcp: false,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      // Should have real tools from the registry
      expect(gatheredInputs.totalTools).toBeGreaterThan(10);
      expect(Object.keys(gatheredInputs.toolSchemas)).toContain("rules.list");

      // Should have rich parameter schemas (not empty)
      const rulesList = gatheredInputs.toolSchemas["rules.list"];
      expect(rulesList).toBeDefined();
      expect(rulesList.description).toBe("List all rules in the workspace");
      expect(rulesList.parameters.type).toBe("object");
      expect(rulesList.parameters.properties).toBeDefined();

      // Should also have test commands
      expect(Object.keys(gatheredInputs.toolSchemas)).toContain("test.command1");
      const testCommand = gatheredInputs.toolSchemas["test.command1"];
      expect(testCommand).toBeDefined();
      expect(testCommand.description).toBe("Test command 1 for testing");
    });

    it("should generate different schemas for different tools", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "cli",
          mcpEnabled: false,
          preferMcp: false,
        },
        commandRegistry: testRegistry,
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      // Check multiple tools have different schemas
      expect(gatheredInputs.toolSchemas["rules.list"]).toBeDefined();
      expect(gatheredInputs.toolSchemas["rules.create"]).toBeDefined();
      expect(gatheredInputs.toolSchemas["test.command1"]).toBeDefined();

      // Verify they are properly structured (all should have proper schema structure)
      const rulesList = gatheredInputs.toolSchemas["rules.list"];
      const rulesCreate = gatheredInputs.toolSchemas["rules.create"];
      const testCommand = gatheredInputs.toolSchemas["test.command1"];

      // All should have the required schema properties
      expect(rulesList.parameters).toBeDefined();
      expect(rulesCreate.parameters).toBeDefined();
      expect(testCommand.parameters).toBeDefined();

      // They should be different tools with different descriptions
      expect(rulesList.description).not.toEqual(rulesCreate.description);
      expect(rulesList.description).not.toEqual(testCommand.description);
    });
  });

  describe("error handling", () => {
    it("should handle component errors gracefully", () => {
      const mockInputs = {
        error: "Failed to load tool schemas",
        toolSchemas: {},
        totalTools: 0,
        interfaceMode: "cli",
        shouldUseMcp: false,
      };

      const result = ToolSchemasComponent.render(mockInputs, mockComponentInput);

      expect(result.content).toInclude("Error loading tool schemas:");
      expect(result.content).toInclude("Failed to load tool schemas");
      expect(result.metadata.componentId).toBe("tool-schemas");
    });
  });
});
