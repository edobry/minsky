import { describe, test, expect } from "bun:test";
import {
  CLI_TO_MCP_MAPPINGS,
  createTemplateHelpers,
  createTemplateContext,
  DEFAULT_CLI_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_HYBRID_CONFIG,
  type RuleGenerationConfig
} from "./template-system";

describe("Template System", () => {
  describe("CLI_TO_MCP_MAPPINGS", () => {
    test("contains expected task command mappings", () => {
      expect(CLI_TO_MCP_MAPPINGS["tasks.list"]).toEqual({
        cli: "minsky tasks list --json",
        mcp: "tasks.list",
        description: "List all tasks in the current repository",
        parameters: {
          "--json": "format: \"json\"",
          "--all": "all: true",
          "--status": "status: string"
        }
      });
      
      expect(CLI_TO_MCP_MAPPINGS["tasks.get"]).toEqual({
        cli: "minsky tasks get #${id} --json",
        mcp: "tasks.get",
        description: "Get a task by ID",
        parameters: {
          "#${id}": "taskId: string",
          "--json": "format: \"json\""
        }
      });
    });
    
    test("contains expected session command mappings", () => {
      expect(CLI_TO_MCP_MAPPINGS["session.start"]).toEqual({
        cli: "minsky session start --task ${id}",
        mcp: "session.start",
        description: "Start a new session",
        parameters: {
          "--task": "task: string",
          "--description": "description: string",
          "--repo": "repo: string"
        }
      });
    });
    
    test("contains expected rules command mappings", () => {
      expect(CLI_TO_MCP_MAPPINGS["rules.list"]).toEqual({
        cli: "minsky rules list --json",
        mcp: "rules.list",
        description: "List all rules in the workspace",
        parameters: {
          "--json": "format: \"json\"",
          "--format": "format: string",
          "--tag": "tag: string"
        }
      });
    });
  });
  
  describe("Template Helpers", () => {
    describe("CLI configuration", () => {
      const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
      
      test("command helper generates CLI command references", () => {
        const result = helpers.command("tasks.list");
        expect(result).toBe("Run `minsky tasks list --json` to List all tasks in the current repository");
      });
      
      test("command helper with custom description", () => {
        const result = helpers.command("tasks.list", "check available tasks");
        expect(result).toBe("Run `minsky tasks list --json` to check available tasks");
      });
      
      test("codeBlock helper generates CLI code examples", () => {
        const result = helpers.codeBlock("tasks.list");
        expect(result).toBe("# Use CLI command\nminsky tasks list --json");
      });
      
      test("workflowStep helper generates CLI workflow steps", () => {
        const result = helpers.workflowStep("First", "tasks.list");
        expect(result).toBe("First: Run `minsky tasks list --json` to List all tasks in the current repository");
      });
    });
    
    describe("MCP configuration", () => {
      const helpers = createTemplateHelpers(DEFAULT_MCP_CONFIG);
      
      test("command helper generates MCP tool references", () => {
        const result = helpers.command("tasks.list");
        expect(result).toBe("Use MCP tool `tasks.list` to List all tasks in the current repository");
      });
      
      test("codeBlock helper generates MCP tool examples", () => {
        const result = helpers.codeBlock("tasks.list");
        expect(result).toBe("// Use MCP tool\ntasks.list");
      });
      
      test("workflowStep helper generates MCP workflow steps", () => {
        const result = helpers.workflowStep("First", "tasks.list");
        expect(result).toBe("First: Use MCP tool `tasks.list` to List all tasks in the current repository");
      });
    });
    
    describe("Hybrid configuration", () => {
      test("prefers CLI when preferMcp is false", () => {
        const config: RuleGenerationConfig = { ...DEFAULT_HYBRID_CONFIG, preferMcp: false };
        const helpers = createTemplateHelpers(config);
        
        const result = helpers.command("tasks.list");
        expect(result).toBe("Run `minsky tasks list --json` to List all tasks in the current repository");
      });
      
      test("prefers MCP when preferMcp is true", () => {
        const config: RuleGenerationConfig = { ...DEFAULT_HYBRID_CONFIG, preferMcp: true };
        const helpers = createTemplateHelpers(config);
        
        const result = helpers.command("tasks.list");
        expect(result).toBe("Use MCP tool `tasks.list` to List all tasks in the current repository");
      });
    });
    
    describe("conditionalSection helper", () => {
      test("includes content for matching interface", () => {
        const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
        const result = helpers.conditionalSection("CLI specific content", ["cli"]);
        expect(result).toBe("CLI specific content");
      });
      
      test("excludes content for non-matching interface", () => {
        const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
        const result = helpers.conditionalSection("MCP specific content", ["mcp"]);
        expect(result).toBe("");
      });
      
      test("includes content for hybrid interface when specified", () => {
        const helpers = createTemplateHelpers(DEFAULT_HYBRID_CONFIG);
        const result = helpers.conditionalSection("Hybrid content", ["hybrid"]);
        expect(result).toBe("Hybrid content");
      });
    });
    
    describe("parameterDoc helper", () => {
      test("generates CLI parameter documentation", () => {
        const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
        const result = helpers.parameterDoc("tasks.list");
        expect(result).toBe("Options: --json --all --status");
      });
      
      test("generates MCP parameter documentation", () => {
        const helpers = createTemplateHelpers(DEFAULT_MCP_CONFIG);
        const result = helpers.parameterDoc("tasks.list");
        expect(result).toBe("Parameters: format: \"json\", all: true, status: string");
      });
      
      test("returns empty string for commands without parameters", () => {
        const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
        // Add a mapping without parameters for testing
        const originalMapping = CLI_TO_MCP_MAPPINGS["test.noparam"];
        CLI_TO_MCP_MAPPINGS["test.noparam"] = {
          cli: "minsky test",
          mcp: "test",
          description: "Test command"
        };
        
        const result = helpers.parameterDoc("test.noparam");
        expect(result).toBe("");
        
        // Clean up
        delete CLI_TO_MCP_MAPPINGS["test.noparam"];
      });
    });
    
    describe("Error handling", () => {
      test("throws error for unknown command mapping", () => {
        const helpers = createTemplateHelpers(DEFAULT_CLI_CONFIG);
        expect(() => helpers.command("unknown.command")).toThrow("Unknown command mapping: unknown.command");
      });
    });
  });
  
  describe("Template Context", () => {
    test("creates complete template context", () => {
      const context = createTemplateContext(DEFAULT_CLI_CONFIG);
      
      expect(context.config).toEqual(DEFAULT_CLI_CONFIG);
      expect(context.helpers).toBeDefined();
      expect(context.commands).toEqual(CLI_TO_MCP_MAPPINGS);
      
      // Test that helpers work through context
      const result = context.helpers.command("tasks.list");
      expect(result).toBe("Run `minsky tasks list --json` to List all tasks in the current repository");
    });
  });
  
  describe("Default Configurations", () => {
    test("DEFAULT_CLI_CONFIG has correct settings", () => {
      expect(DEFAULT_CLI_CONFIG).toEqual({
        interface: "cli",
        mcpEnabled: false,
        mcpTransport: "stdio",
        preferMcp: false,
        ruleFormat: "cursor"
      });
    });
    
    test("DEFAULT_MCP_CONFIG has correct settings", () => {
      expect(DEFAULT_MCP_CONFIG).toEqual({
        interface: "mcp",
        mcpEnabled: true,
        mcpTransport: "stdio",
        preferMcp: true,
        ruleFormat: "cursor"
      });
    });
    
    test("DEFAULT_HYBRID_CONFIG has correct settings", () => {
      expect(DEFAULT_HYBRID_CONFIG).toEqual({
        interface: "hybrid",
        mcpEnabled: true,
        mcpTransport: "stdio",
        preferMcp: false,
        ruleFormat: "cursor"
      });
    });
  });
}); 
