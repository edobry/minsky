import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "os";
import { promises as fs } from "fs";
import path from "path";
import {
  RuleTemplateService,
  createRuleTemplateService,
  generateRulesWithConfig,
  type RuleTemplate,
  type GenerateRulesOptions,
} from "./rule-template-service";
import { registerAllSharedCommands } from "../../adapters/shared/commands";
import { sharedCommandRegistry } from "../../adapters/shared/command-registry";
import {
  type RuleGenerationConfig,
  DEFAULT_CLI_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_HYBRID_CONFIG,
} from "./template-system";

// Mock default templates to avoid command registry conflicts
mock.module("./default-templates", () => ({
  DEFAULT_TEMPLATES: [
    {
      id: "mock-default",
      name: "Mock Default Template",
      description: "Mock template for testing",
      generateContent: () => "# Mock Default\n\nThis is a mock template.",
    },
    {
      id: "minsky-workflow",
      name: "Minsky Workflow",
      description: "Mock minsky workflow template",
      generateContent: () => "# Minsky Workflow\n\nMock workflow content.",
    },
    {
      id: "test-template",
      name: "Test Template",
      description: "Another mock template",
      generateContent: () => "# Test Template\n\nTest content.",
    },
  ],
}));

// One-time setup for commands
let commandsRegistered = false;

describe("RuleTemplateService", () => {
  let testDir: string;
  let service: RuleTemplateService;

  beforeEach(async () => {
    // Create unique temporary directory for each test
    testDir = await fs.mkdtemp(path.join(tmpdir(), "rule-template-test-"));

    // Register commands once
    if (!commandsRegistered) {
      registerAllSharedCommands();
      commandsRegistered = true;
    }

    service = new RuleTemplateService(testDir);

    // Register a test template used by factory and file system tests
    service.registerTemplate({
      id: "test-template",
      name: "Test Rule",
      description: "Test rule for unit tests",
      generateContent: (context) =>
        `# Test Rule\n\n${context.helpers.command("tasks.list", "list all tasks")}`,
    });
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });

    // Clear the command registry to prevent interference with other tests
    (sharedCommandRegistry as any).clear();
    commandsRegistered = false;
  });

  describe("Template Registration", () => {
    test("registers templates correctly", () => {
      const template: RuleTemplate = {
        id: "test-rule",
        name: "Test Rule",
        description: "A test rule",
        generateContent: () => "test content",
      };

      service.registerTemplate(template);

      expect(service.getTemplate("test-rule")).toEqual(template);
      expect(service.getTemplates()).toHaveLength(4); // 3 mocked default (beforeEach replaces one) + 1 registered
    });

    test("getTemplate returns undefined for non-existent template", () => {
      expect(service.getTemplate("non-existent")).toBeUndefined();
    });

    test("getTemplates returns all registered templates", () => {
      const template1: RuleTemplate = {
        id: "rule1",
        name: "Rule 1",
        description: "First rule",
        generateContent: () => "content 1",
      };

      const template2: RuleTemplate = {
        id: "rule2",
        name: "Rule 2",
        description: "Second rule",
        generateContent: () => "content 2",
      };

      service.registerTemplate(template1);
      service.registerTemplate(template2);

      const templates = service.getTemplates();
      expect(templates).toHaveLength(5); // 3 mocked default (beforeEach replaces one) + 2 registered
      expect(templates.some((t) => t.id === "rule1")).toBe(true);
      expect(templates.some((t) => t.id === "rule2")).toBe(true);
    });
  });

  describe("Single Rule Generation", () => {
    test("generates rule with CLI configuration", async () => {
      const template: RuleTemplate = {
        id: "cli-rule",
        name: "CLI Rule",
        description: "A CLI-focused rule",
        generateContent: (context) => {
          return `# CLI Rule\n\n${context.helpers.command("tasks.list", "list tasks")}`;
        },
      };

      service.registerTemplate(template);

      const result = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["cli-rule"],
        dryRun: true,
      });

      if (!result.success) {
        console.error("Generation failed with errors:", result.errors);
      }
      expect(result.success).toBe(true);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]!.id).toBe("cli-rule");
      expect(result.rules[0]!.content).toContain("minsky tasks list");
    });

    test("generates rule with MCP configuration", async () => {
      const template: RuleTemplate = {
        id: "mcp-rule",
        name: "MCP Rule",
        description: "An MCP-focused rule",
        generateContent: (context) => {
          return `# MCP Rule\n\n${context.helpers.command("tasks.list", "list tasks")}`;
        },
      };

      service.registerTemplate(template);

      const result = await service.generateRules({
        config: DEFAULT_MCP_CONFIG,
        selectedRules: ["mcp-rule"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]!.content).toContain("mcp_minsky-server_tasks_list");
    });

    test("generates rule with hybrid configuration preferring CLI", async () => {
      const template: RuleTemplate = {
        id: "hybrid-rule",
        name: "Hybrid Rule",
        description: "A hybrid rule",
        generateContent: (context) => {
          return `# Hybrid Rule\n\n${context.helpers.command("tasks.list")}`;
        },
      };

      service.registerTemplate(template);

      const config: RuleGenerationConfig = { ...DEFAULT_HYBRID_CONFIG, preferMcp: false };
      const result = await service.generateRules({
        config,
        selectedRules: ["hybrid-rule"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.rules[0]!.content).toContain("minsky tasks list");
    });

    test("generates rule with hybrid configuration preferring MCP", async () => {
      const template: RuleTemplate = {
        id: "hybrid-rule",
        name: "Hybrid Rule",
        description: "A hybrid rule",
        generateContent: (context) => {
          return `# Hybrid Rule\n\n${context.helpers.command("tasks.list")}`;
        },
      };

      service.registerTemplate(template);

      const config: RuleGenerationConfig = { ...DEFAULT_HYBRID_CONFIG, preferMcp: true };
      const result = await service.generateRules({
        config,
        selectedRules: ["hybrid-rule"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.rules[0]!.content).toContain("mcp_minsky-server_tasks_list");
    });
  });

  describe("Multiple Rule Generation", () => {
    test("generates multiple rules", async () => {
      const template1: RuleTemplate = {
        id: "rule1",
        name: "Rule 1",
        description: "First rule",
        generateContent: () => "Content 1",
      };

      const template2: RuleTemplate = {
        id: "rule2",
        name: "Rule 2",
        description: "Second rule",
        generateContent: () => "Content 2",
      };

      service.registerTemplate(template1);
      service.registerTemplate(template2);

      const result = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["rule1", "rule2"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.rules).toHaveLength(2);
      expect(result.rules.some((r) => r.id === "rule1")).toBe(true);
      expect(result.rules.some((r) => r.id === "rule2")).toBe(true);
    });

    test("generates all rules when none specified", async () => {
      const template: RuleTemplate = {
        id: "additional-rule",
        name: "Additional Rule",
        description: "An additional rule",
        generateContent: () => "Additional content",
      };

      service.registerTemplate(template);

      const result = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        dryRun: true,
      });

      if (!result.success) {
        console.error("Default template generation failed:", result.errors);
      }
      expect(result.success).toBe(true);
      expect(result.rules.length).toBeGreaterThan(3); // Should include 3 default templates + additional
      expect(result.rules.some((r) => r.id === "additional-rule")).toBe(true);
      expect(result.rules.some((r) => r.id === "minsky-workflow")).toBe(true);
    });

    test("handles generation errors gracefully", async () => {
      const faultyTemplate: RuleTemplate = {
        id: "faulty-rule",
        name: "Faulty Rule",
        description: "A rule that will fail",
        generateContent: () => {
          throw new Error("Template generation failed");
        },
      };

      service.registerTemplate(faultyTemplate);

      const result = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["faulty-rule"],
        dryRun: true,
      });

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Template generation failed");
    });
  });

  describe("Template Helper Integration", () => {
    test("template can use all helper functions", async () => {
      const template: RuleTemplate = {
        id: "helper-test",
        name: "Helper Test",
        description: "Tests all helper functions",
        generateContent: (context) => {
          const { helpers } = context;
          return `# Helper Test

## Command Reference
${helpers.command("tasks.list", "list all tasks")}

## Code Block
\`\`\`bash
${helpers.codeBlock("minsky session start --task 123", "bash")}
\`\`\`

## Workflow Step
${helpers.workflowStep("tasks.status.get", "check task status")}

## Parameter Documentation
${helpers.parameterDoc("tasks.list")}

## Conditional Content
${helpers.conditionalSection(context.config.interface === "cli", "This appears for CLI")}
${helpers.conditionalSection(context.config.interface === "mcp", "This appears for MCP")}
`;
        },
      };

      service.registerTemplate(template);

      // Test CLI configuration
      const cliResult = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["helper-test"],
        dryRun: true,
      });

      if (!cliResult.success) {
        console.error("Helper test failed:", cliResult.errors);
      }
      expect(cliResult.success).toBe(true);
      const cliContent = cliResult.rules[0]!.content;
      expect(cliContent).toContain("minsky tasks list");
      expect(cliContent).toContain("minsky session start --task 123");
      expect(cliContent).toContain("check task status");
      expect(cliContent).toContain("Optional");
      expect(cliContent).toContain("This appears for CLI");
      expect(cliContent).not.toContain("This appears for MCP");

      // Test MCP configuration
      const mcpResult = await service.generateRules({
        config: DEFAULT_MCP_CONFIG,
        selectedRules: ["helper-test"],
        dryRun: true,
      });

      expect(mcpResult.success).toBe(true);
      const mcpContent = mcpResult.rules[0]!.content;
      expect(mcpContent).toContain("mcp_minsky-server_tasks_list");
      expect(mcpContent).toContain("minsky session start --task 123");
      expect(mcpContent).toContain("mcp_minsky-server_tasks_status_get");
      expect(mcpContent).toContain("Optional");
      expect(mcpContent).not.toContain("This appears for CLI");
      expect(mcpContent).toContain("This appears for MCP");
    });
  });

  describe("Custom Metadata Generation", () => {
    test("applies custom metadata generation", async () => {
      const template: RuleTemplate = {
        id: "custom-meta",
        name: "Custom Meta",
        description: "Rule with custom metadata",
        generateContent: () => "Content",
        generateMeta: (context) => ({
          globs: context.config.interface === "mcp" ? ["**/*.mcp.ts"] : ["**/*.cli.ts"],
          alwaysApply: context.config.interface === "cli",
          tags: [context.config.interface, "custom"],
        }),
      };

      service.registerTemplate(template);

      // Test CLI metadata
      const cliResult = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["custom-meta"],
        dryRun: true,
      });

      expect(cliResult.success).toBe(true);
      const cliRule = cliResult.rules[0];
      expect(cliRule.globs).toEqual(["**/*.cli.ts"]);
      expect(cliRule.alwaysApply).toBe(true);
      expect(cliRule.tags).toContain("cli");
      expect(cliRule.tags).toContain("custom");

      // Test MCP metadata
      const mcpResult = await service.generateRules({
        config: DEFAULT_MCP_CONFIG,
        selectedRules: ["custom-meta"],
        dryRun: true,
      });

      expect(mcpResult.success).toBe(true);
      const mcpRule = mcpResult.rules[0];
      expect(mcpRule.globs).toEqual(["**/*.mcp.ts"]);
      expect(mcpRule.alwaysApply).toBe(false);
      expect(mcpRule.tags).toContain("mcp");
      expect(mcpRule.tags).toContain("custom");
    });
  });

  describe("Configuration Presets", () => {
    test("generateCliRules uses CLI configuration", async () => {
      const template: RuleTemplate = {
        id: "preset-test",
        name: "Preset Test",
        description: "Tests configuration presets",
        generateContent: (context) => context.helpers.command("tasks.list"),
      };

      service.registerTemplate(template);

      const result = await service.generateCliRules({
        selectedRules: ["preset-test"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.config.interface).toBe("cli");
      expect(result.rules[0].content).toContain("minsky tasks list");
    });

    test("generateMcpRules uses MCP configuration", async () => {
      const template: RuleTemplate = {
        id: "preset-test",
        name: "Preset Test",
        description: "Tests configuration presets",
        generateContent: (context) => context.helpers.command("tasks.list"),
      };

      service.registerTemplate(template);

      const result = await service.generateMcpRules({
        selectedRules: ["preset-test"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.config.interface).toBe("mcp");
      expect(result.rules[0].content).toContain("mcp_minsky-server_tasks_list");
    });

    test("generateHybridRules uses hybrid configuration", async () => {
      const template: RuleTemplate = {
        id: "preset-test",
        name: "Preset Test",
        description: "Tests configuration presets",
        generateContent: (context) => context.helpers.command("tasks.list"),
      };

      service.registerTemplate(template);

      const result = await service.generateHybridRules({
        selectedRules: ["preset-test"],
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.config.interface).toBe("hybrid");
      // Should prefer CLI by default (preferMcp: false)
      expect(result.rules[0].content).toContain("minsky tasks list");
    });
  });

  describe("Factory Functions", () => {
    test("createRuleTemplateService creates service correctly", () => {
      const factoryService = createRuleTemplateService(testDir);
      expect(factoryService).toBeInstanceOf(RuleTemplateService);
      expect(factoryService.getTemplates().length).toBeGreaterThanOrEqual(3); // Should have 3 default templates
    });

    test("generateRulesWithConfig generates rules correctly", async () => {
      const result = await generateRulesWithConfig(testDir, DEFAULT_CLI_CONFIG, {
        selectedRules: ["minsky-workflow"],
        dryRun: true,
      });

      if (!result.success) {
        console.error("generateRulesWithConfig failed:", result.errors);
      }
      expect(result.success).toBe(true);
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].id).toBe("minsky-workflow");
      expect(result.config).toEqual(DEFAULT_CLI_CONFIG);
    });
  });

  describe("File System Integration", () => {
    test("creates actual rule files when not in dry run mode", async () => {
      // Create directory structure
      await fs.mkdir(path.join(testDir, ".cursor", "rules"), { recursive: true });

      const result = await service.generateRules({
        config: DEFAULT_CLI_CONFIG,
        selectedRules: ["test-template"],
        dryRun: false,
        overwrite: true,
      });

      if (!result.success) {
        console.error("File system integration test failed:", result.errors);
      }
      expect(result.success).toBe(true);

      // Check that file was actually created
      const filePath = path.join(testDir, ".cursor", "rules", "test-template.mdc");
      const fileExists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      // Check file content
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("# Test Rule");
      expect(content).toContain("minsky tasks list");
    });
  });
});
