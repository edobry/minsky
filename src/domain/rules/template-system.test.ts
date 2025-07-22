import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  createTemplateContext,
  DEFAULT_CLI_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_HYBRID_CONFIG,
  type RuleGenerationConfig,
  type TemplateContext
} from "./template-system";

// Mock the command generator
mock.module("./command-generator", () => {
  const mockCommandSyntax = (commandId: string, config: any) => {
    if (config.interfaceMode === "cli") {
      return `minsky ${commandId.replace(".", " ")}`;
    } else {
      return `mcp_minsky_server_${commandId}(...)`;
    }
  };
  
  const mockDocumentation = (commandId: string) => {
    return `Documentation for ${commandId}`;
  };
  
  const mockService = {
    getCommandSyntax: jest.fn(mockCommandSyntax),
    getCommandsByCategory: jest.fn(),
    getParameterDocumentation: jest.fn(mockDocumentation),
    updateConfig: jest.fn()
  };
  
  return {
    createCommandGeneratorService: jest.fn(() => mockService),
    getCommandSyntax: jest.fn(mockCommandSyntax),
    getParameterDocumentation: jest.fn(mockDocumentation)
  };
});

// Mock the shared command registry
mock.module("../../adapters/shared/command-registry", () => {
  return {
    CommandCategory: {
      TASKS: "TASKS",
      GIT: "GIT",
      SESSION: "SESSION"
    },
    sharedCommandRegistry: {
      getCommand: jest.fn(),
      getCommandsByCategory: jest.fn(),
    }
  };
});

describe("Template System", () => {
  let cliContext: TemplateContext;
  let mcpContext: TemplateContext;
  let hybridContext: TemplateContext;
  
  beforeEach(() => {
    // Create contexts with different configurations
    cliContext = createTemplateContext(DEFAULT_CLI_CONFIG);
    mcpContext = createTemplateContext(DEFAULT_MCP_CONFIG);
    hybridContext = createTemplateContext(DEFAULT_HYBRID_CONFIG);
  });
  
  describe("createTemplateContext", () => {
    test("should create context with proper config", () => {
      const context = createTemplateContext({
        interface: "cli",
        mcpEnabled: false,
        mcpTransport: "stdio",
        preferMcp: false,
        ruleFormat: "cursor",
        outputDir: "/path/to/rules"
      });
      
      expect(context).toBeDefined();
      expect(context.config.interface).toBe("cli");
      expect(context.config.ruleFormat).toBe("cursor");
      expect(context.helpers).toBeDefined();
      expect(context.commandGenerator).toBeDefined();
    });
  });
  
  describe("helpers.command", () => {
    test("CLI context should generate CLI command references", () => {
      const result = cliContext.helpers.command("tasks.list", "list tasks");
      expect(result).toBe("minsky tasks list - list tasks");
    });
    
    test("MCP context should generate MCP command references", () => {
      const result = mcpContext.helpers.command("tasks.list", "list tasks");
      expect(result).toBe("mcp_minsky_server_tasks.list(...) - list tasks");
    });
    
    test("Hybrid context should default to CLI references when preferMcp is false", () => {
      const result = hybridContext.helpers.command("tasks.list", "list tasks");
      expect(result).toBe("minsky tasks list - list tasks");
    });
    
    test("should work without description", () => {
      const result = cliContext.helpers.command("tasks.list");
      expect(result).toBe("minsky tasks list");
    });
    
    test("should throw error for unknown command", () => {
      // Override the mock implementation for unknown command
      cliContext.commandGenerator.getCommandSyntax = jest.fn(() => null);
      
      expect(() => {
        cliContext.helpers.command("unknown.command");
      }).toThrow("Command not found");
    });
  });
  
  describe("helpers.codeBlock", () => {
    test("should wrap content in code block with language", () => {
      const result = cliContext.helpers.codeBlock("echo 'hello'", "bash");
      expect(result).toBe("```bash\necho 'hello'\n```");
    });
    
    test("should default to bash language", () => {
      const result = cliContext.helpers.codeBlock("echo 'hello'");
      expect(result).toBe("```bash\necho 'hello'\n```");
    });
  });
  
  describe("helpers.conditionalSection", () => {
    test("should include content when condition is true", () => {
      const result = cliContext.helpers.conditionalSection(true, "content");
      expect(result).toBe("content");
    });
    
    test("should exclude content when condition is false", () => {
      const result = cliContext.helpers.conditionalSection(false, "content");
      expect(result).toBe("");
    });
    
    test("should use fallback content when condition is false and fallback is provided", () => {
      const result = cliContext.helpers.conditionalSection(false, "content", "fallback");
      expect(result).toBe("fallback");
    });
  });
  
  describe("helpers.parameterDoc", () => {
    test("should generate parameter documentation", () => {
      const result = cliContext.helpers.parameterDoc("tasks.list");
      expect(result).toBe("Documentation for tasks.list");
    });
  });
  
  describe("helpers.workflowStep", () => {
    test("should generate CLI workflow step", () => {
      const result = cliContext.helpers.workflowStep("tasks.list", "List all tasks");
      expect(result).toContain("**List all tasks**");
      expect(result).toContain("minsky tasks list");
    });
    
    test("should generate MCP workflow step", () => {
      const result = mcpContext.helpers.workflowStep("tasks.list", "List all tasks");
      expect(result).toContain("**List all tasks**");
      expect(result).toContain("mcp_minsky_server_tasks.list");
    });
    
    test("should throw error for unknown command", () => {
      // Override the mock implementation for unknown command
      cliContext.commandGenerator.getCommandSyntax = jest.fn().mockReturnValue(null);
      
      expect(() => {
        cliContext.helpers.workflowStep("unknown.command", "Test step");
      }).toThrow("Command not found");
    });
  });
  
  describe("DEFAULT_CLI_CONFIG", () => {
    test("should have proper CLI defaults", () => {
      expect(DEFAULT_CLI_CONFIG.interface).toBe("cli");
      expect(DEFAULT_CLI_CONFIG.mcpEnabled).toBe(false);
      expect(DEFAULT_CLI_CONFIG.preferMcp).toBe(false);
    });
  });
  
  describe("DEFAULT_MCP_CONFIG", () => {
    test("should have proper MCP defaults", () => {
      expect(DEFAULT_MCP_CONFIG.interface).toBe("mcp");
      expect(DEFAULT_MCP_CONFIG.mcpEnabled).toBe(true);
      expect(DEFAULT_MCP_CONFIG.preferMcp).toBe(true);
    });
  });
  
  describe("DEFAULT_HYBRID_CONFIG", () => {
    test("should have proper hybrid defaults", () => {
      expect(DEFAULT_HYBRID_CONFIG.interface).toBe("hybrid");
      expect(DEFAULT_HYBRID_CONFIG.mcpEnabled).toBe(true);
      expect(DEFAULT_HYBRID_CONFIG.preferMcp).toBe(false);
    });
  });
}); 
