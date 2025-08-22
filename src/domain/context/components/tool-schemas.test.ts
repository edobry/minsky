import { describe, it, expect, beforeAll } from "bun:test";
import { ToolSchemasComponent } from "./tool-schemas";
import type { ComponentInput } from "./types";
import { registerAllSharedCommands } from "../../../adapters/shared/commands";

describe("ToolSchemasComponent", () => {
  // Register all commands before running tests
  beforeAll(async () => {
    await registerAllSharedCommands();
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
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      expect(gatheredInputs.interfaceMode).toBe("hybrid");
      expect(gatheredInputs.shouldUseMcp).toBe(true);
    });

    it("should default to CLI when no interfaceConfig provided", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        // No interfaceConfig provided
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
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      // Should have real tools from the registry
      expect(gatheredInputs.totalTools).toBeGreaterThan(10);
      expect(Object.keys(gatheredInputs.toolSchemas)).toContain("tasks.list");

      // Should have rich parameter schemas (not empty)
      const tasksList = gatheredInputs.toolSchemas["tasks.list"];
      expect(tasksList).toBeDefined();
      expect(tasksList.description).toBe("List tasks");
      expect(tasksList.parameters.type).toBe("object");
      expect(tasksList.parameters.properties).toBeDefined();
      expect(Object.keys(tasksList.parameters.properties)).toContain("status");

      // Should have proper parameter types and descriptions
      const statusParam = tasksList.parameters.properties.status;
      expect(statusParam.type).toBe("string");
      expect(statusParam.enum).toContain("TODO");
      expect(statusParam.enum).toContain("IN-PROGRESS");
      expect(statusParam.description).toBe("Task status");
    });

    it("should generate different schemas for different tools", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        interfaceConfig: {
          interface: "cli",
          mcpEnabled: false,
          preferMcp: false,
        },
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      // Check multiple tools have different schemas
      expect(gatheredInputs.toolSchemas["tasks.list"]).toBeDefined();
      expect(gatheredInputs.toolSchemas["tasks.create"]).toBeDefined();
      expect(gatheredInputs.toolSchemas["session.start"]).toBeDefined();

      // Verify they have different parameter structures
      const listParams = gatheredInputs.toolSchemas["tasks.list"].parameters.properties;
      const createParams = gatheredInputs.toolSchemas["tasks.create"].parameters.properties;

      expect(Object.keys(listParams)).not.toEqual(Object.keys(createParams));
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
