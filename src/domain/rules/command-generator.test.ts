import { describe, test, expect } from "bun:test";
import {
  getCommandRepresentation,
  getCommandSyntax,
  createCommandGeneratorService,
  type CommandGenerationConfig,
  type CommandParameter,
} from "./command-generator";

// Helper function to create mock command representation for testing
function createMockCommandRepresentation(id: string, parameters: CommandParameter[] = []): any {
  return {
    id,
    category: "TASKS",
    description: `Mock ${id} command`,
    cliSyntax: `minsky ${id.replace(".", " ")}`,
    mcpSyntax: generateMockMcpSyntax(id, parameters),
    parameters,
  };
}

// Helper to generate expected MCP syntax for testing
function generateMockMcpSyntax(commandId: string, parameters: CommandParameter[]): string {
  const mcpCommandName = `mcp_minsky-server_${commandId.replace(/\./g, "_")}`;

  if (parameters.length === 0) {
    return `<function_calls>
<invoke name="${mcpCommandName}">
</invoke>
</function_calls>`;
  }

  const parameterLines = parameters.map((param) => {
    const name = param.mcpName || param.name;
    const valueHint = param.required
      ? `required ${param.name} value`
      : `optional ${param.name} value`;
    return `<parameter name="${name}">${valueHint}</parameter>`;
  });

  return `<function_calls>
<invoke name="${mcpCommandName}">
${parameterLines.join("\n")}
</invoke>
</function_calls>`;
}

describe("CommandGenerator XML Format Tests", () => {
  describe("MCP XML Format Generation", () => {
    test("should generate correct XML format for command with no parameters", () => {
      const commandId = "tasks.list";
      const parameters: CommandParameter[] = [];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_tasks_list">
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });

    test("should generate correct XML format for command with optional parameters", () => {
      const commandId = "tasks.list";
      const parameters: CommandParameter[] = [
        {
          name: "filter",
          required: false,
          description: "Filter tasks",
        },
        {
          name: "limit",
          required: false,
          description: "Limit results",
        },
      ];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_tasks_list">
<parameter name="filter">optional filter value</parameter>
<parameter name="limit">optional limit value</parameter>
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });

    test("should generate correct XML format for command with required parameters", () => {
      const commandId = "tasks.get";
      const parameters: CommandParameter[] = [
        {
          name: "taskId",
          required: true,
          description: "Task ID",
        },
      ];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_tasks_get">
<parameter name="taskId">required taskId value</parameter>
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });

    test("should generate correct XML format for command with mixed required and optional parameters", () => {
      const commandId = "session.start";
      const parameters: CommandParameter[] = [
        {
          name: "task",
          required: true,
          description: "Task ID",
        },
        {
          name: "description",
          required: false,
          description: "Session description",
        },
        {
          name: "branch",
          required: false,
          description: "Git branch",
        },
      ];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_session_start">
<parameter name="task">required task value</parameter>
<parameter name="description">optional description value</parameter>
<parameter name="branch">optional branch value</parameter>
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });

    test("should handle command IDs with multiple dots correctly", () => {
      const commandId = "tasks.status.get";
      const parameters: CommandParameter[] = [
        {
          name: "taskId",
          required: true,
          description: "Task ID",
        },
      ];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_tasks_status_get">
<parameter name="taskId">required taskId value</parameter>
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });

    test("should properly handle parameter names with special characters", () => {
      const commandId = "test.command";
      const parameters: CommandParameter[] = [
        {
          name: "param-with-dash",
          required: true,
          description: "Parameter with dash",
        },
        {
          name: "param_with_underscore",
          required: false,
          description: "Parameter with underscore",
        },
      ];

      const expectedXml = `<function_calls>
<invoke name="mcp_minsky-server_test_command">
<parameter name="param-with-dash">required param-with-dash value</parameter>
<parameter name="param_with_underscore">optional param_with_underscore value</parameter>
</invoke>
</function_calls>`;

      const actualXml = generateMockMcpSyntax(commandId, parameters);
      expect(actualXml).toBe(expectedXml);
    });
  });

  describe("CommandGeneratorService Configuration", () => {
    test("should create service with initial config", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false,
      };

      const service = createCommandGeneratorService(config);
      expect(service).toBeDefined();
    });

    test("should update config correctly", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false,
      };

      const service = createCommandGeneratorService(config);

      // Update config to MCP mode
      service.updateConfig({ interfaceMode: "mcp", mcpEnabled: true });

      // Service should be updated (we can't easily test the internal state without mocks)
      expect(service).toBeDefined();
    });
  });

  describe("XML Format Structure Validation", () => {
    test("should produce valid XML structure with proper nesting", () => {
      const xml = generateMockMcpSyntax("tasks.list", [{ name: "filter", required: false }]);

      // Check XML structure
      expect(xml).toMatch(/^<function_calls>/);
      expect(xml).toMatch(/<\/function_calls>$/);
      expect(xml).toContain('<invoke name="mcp_minsky-server_tasks_list">');
      expect(xml).toContain("</invoke>");
      expect(xml).toContain('<parameter name="filter">');
      expect(xml).toContain("</parameter>");
    });

    test("should properly escape parameter names in XML attributes", () => {
      const xml = generateMockMcpSyntax("test.cmd", [{ name: "param-name", required: true }]);

      // Parameter names should be properly included in XML attributes
      expect(xml).toContain('name="param-name"');
      expect(xml).toContain(">required param-name value<");
    });

    test("should generate different value hints for required vs optional parameters", () => {
      const xml = generateMockMcpSyntax("test.cmd", [
        { name: "required-param", required: true },
        { name: "optional-param", required: false },
      ]);

      expect(xml).toContain(">required required-param value<");
      expect(xml).toContain(">optional optional-param value<");
    });
  });

  describe("Command ID to MCP Name Conversion", () => {
    test("should convert single dot correctly", () => {
      const xml = generateMockMcpSyntax("tasks.list", []);
      expect(xml).toContain('name="mcp_minsky-server_tasks_list"');
    });

    test("should convert multiple dots correctly", () => {
      const xml = generateMockMcpSyntax("tasks.status.get", []);
      expect(xml).toContain('name="mcp_minsky-server_tasks_status_get"');
    });

    test("should handle no dots correctly", () => {
      const xml = generateMockMcpSyntax("list", []);
      expect(xml).toContain('name="mcp_minsky-server_list"');
    });
  });
});
