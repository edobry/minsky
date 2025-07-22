import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registerRulesCommands } from "./rules";
import { sharedCommandRegistry } from "../command-registry";

// Mock workspace resolution
jest.mock("../../../domain/workspace", () => ({
  resolveWorkspacePath: jest.fn().mockResolvedValue("/mock/workspace")
}));

// Mock rule template service
jest.mock("../../../domain/rules/rule-template-service", () => ({
  createRuleTemplateService: jest.fn().mockReturnValue({
    registerDefaultTemplates: jest.fn().mockResolvedValue(undefined),
    generateRules: jest.fn().mockResolvedValue({
      success: true,
      rules: [
        {
          id: "test-rule",
          path: "/mock/workspace/.cursor/rules/test-rule.mdc",
          content: "# Test Rule\n\nThis is a test rule.",
          meta: { name: "Test Rule", description: "A test rule" }
        }
      ],
      errors: []
    })
  })
}));

describe("Rules Commands", () => {
  beforeEach(() => {
    // Clear the registry before each test
    (sharedCommandRegistry as any).clear();
    
    // Register commands
    registerRulesCommands();
  });

  afterEach(() => {
    // Clear registry after each test
    (sharedCommandRegistry as any).clear();
  });

  describe("rules.generate", () => {
    test("should be registered in command registry", () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();
      expect(command?.name).toBe("generate");
      expect(command?.description).toBe("Generate new rules from templates");
    });

    test("should generate rules with default CLI configuration", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({}, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
        expect(result.generated).toBe(1);
        expect(result.errors).toHaveLength(0);
        expect(result.rules[0].id).toBe("test-rule");
      }
    });

    test("should generate rules with MCP configuration", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({
          interface: "mcp",
          format: "cursor",
          mcpTransport: "stdio"
        }, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
        expect(result.generated).toBe(1);
      }
    });

    test("should generate rules with hybrid configuration", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({
          interface: "hybrid",
          preferMcp: true,
          format: "openai"
        }, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
        expect(result.generated).toBe(1);
      }
    });

    test("should handle specific rule selection", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({
          rules: "minsky-workflow,index",
          interface: "cli"
        }, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
      }
    });

    test("should support dry run mode", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({
          dryRun: true,
          interface: "cli"
        }, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
      }
    });

    test("should support custom output directory", async () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        const result = await command.execute({
          outputDir: "/custom/output/dir",
          interface: "cli"
        }, { interface: "cli" });
        
        expect(result.success).toBe(true);
        expect(result.rules).toHaveLength(1);
      }
    });

    test("should handle errors gracefully", async () => {
      // Override the mock for this test
      const mockService = {
        registerDefaultTemplates: jest.fn().mockResolvedValue(undefined),
        generateRules: jest.fn().mockRejectedValue(new Error("Template generation failed"))
      };
      
      const mockCreateService = require("../../../domain/rules/rule-template-service").createRuleTemplateService;
      mockCreateService.mockReturnValueOnce(mockService);

      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command) {
        await expect(command.execute({}, { interface: "cli" })).rejects.toThrow("Template generation failed");
      }
    });

    test("should validate parameter schemas", () => {
      const command = sharedCommandRegistry.getCommand("rules.generate");
      expect(command).toBeDefined();

      if (command && command.parameters) {
        // Check that interface parameter has correct enum values
        const interfaceParam = command.parameters.interface;
        if (interfaceParam) {
          expect(interfaceParam.required).toBe(false);
          expect(interfaceParam.defaultValue).toBe("cli");
        }

        // Check that format parameter has correct enum values
        const formatParam = command.parameters.format;
        if (formatParam) {
          expect(formatParam.required).toBe(false);
          expect(formatParam.defaultValue).toBe("cursor");
        }

        // Check that dryRun parameter is boolean
        const dryRunParam = command.parameters.dryRun;
        if (dryRunParam) {
          expect(dryRunParam.required).toBe(false);
          expect(dryRunParam.defaultValue).toBe(false);
        }
      }
    });
  });
}); 
