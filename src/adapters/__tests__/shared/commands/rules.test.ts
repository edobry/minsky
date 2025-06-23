/**
 * Shared Rules Commands Tests
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { registerRulesCommands } from "../../../../adapters/shared/commands/rules.js";
import {
  sharedCommandRegistry,
  CommandCategory,
} from "../../../../adapters/shared/command-registry.js";
import * as workspace from "../../../../domain/workspace.js";
import {
  expectToHaveLength,
  expectToBeInstanceOf,
  expectToHaveBeenCalled,
  getMockCallArg,
} from "../../../../utils/test-utils/assertions.js";

// Define interfaces for mock object types
interface MockRuleService {
  listRules: (options?: any) => Promise<any[]>;
  getRule: (id: string, options?: any) => Promise<any>;
  createRule: (id: string, content: string, meta: any, options?: any) => Promise<any>;
  updateRule: (id: string, updates: any, options?: any) => Promise<any>;
  searchRules: (options?: any) => Promise<any[]>;
}

describe("Shared Rules Commands", () => {
  // Set up spies for domain functions
  let resolveWorkspacePathSpy: ReturnType<typeof spyOn>;
  let listRulesSpy: ReturnType<typeof spyOn>;
  let getRuleSpy: ReturnType<typeof spyOn>;
  let createRuleSpy: ReturnType<typeof spyOn>;
  let updateRuleSpy: ReturnType<typeof spyOn>;
  let searchRulesSpy: ReturnType<typeof spyOn>;

  // Mock rule service instance
  let mockRuleService: MockRuleService;

  beforeEach(() => {
    // Mock rules helper functions with correct module path
    mock.module("../../../../utils/rules-helpers.js", () => ({
      readContentFromFileIfExists: async (path: string) => "# Rule Content from File",
      parseGlobs: (globs: string) => globs.split(",").map((g) => g.trim()),
    }));

    // Set up spy for workspace path resolution
    resolveWorkspacePathSpy = spyOn(workspace, "resolveWorkspacePath").mockImplementation(() =>
      Promise.resolve("/test/workspace")
    );

    // Create mock object for methods
    mockRuleService = {
      listRules: (_options?: any) =>
        Promise.resolve([
          {
            id: "test-rule-1",
            name: "Test Rule 1",
            description: "Test rule 1 description",
            content: "# Test Rule 1 Content",
            format: "cursor",
            path: "/test/workspace/.cursor/rules/test-rule-1.mdc",
            globs: ["*.ts"],
            tags: ["test"],
          },
          {
            id: "test-rule-2",
            name: "Test Rule 2",
            description: "Test rule 2 description",
            content: "# Test Rule 2 Content",
            format: "generic",
            path: "/test/workspace/.ai/rules/test-rule-2.mdc",
            globs: ["*.md"],
            tags: ["docs"],
          },
        ]),
      getRule: (id: string, _options?: any) =>
        Promise.resolve({
          id,
          name: `Rule ${id}`,
          description: `Description for rule ${id}`,
          content: `# Content for rule ${id}`,
          format: _options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: ["*.ts"],
          tags: ["test"],
        }),
      createRule: (id: string, content: string, meta: any, options?: any) =>
        Promise.resolve({
          id,
          name: meta.name,
          description: meta.description,
          content,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: meta.globs,
          tags: meta.tags,
        }),
      updateRule: (id: string, updates: any, options?: any) =>
        Promise.resolve({
          id,
          name: updates.meta?.name || `Rule ${id}`,
          description: updates.meta?.description || `Description for rule ${id}`,
          content: updates.content || `# Content for rule ${id}`,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: updates.meta?.globs || ["*.ts"],
          tags: updates.meta?.tags || ["test"],
        }),
      searchRules: (options?: any) =>
        Promise.resolve([
          {
            id: "test-search-rule",
            name: "Test Search Rule",
            description: "This rule matches the search query",
            content: "# Test Rule Content",
            format: options?.format || "cursor",
            path: "/test/workspace/.cursor/rules/test-search-rule.mdc",
            globs: ["*.ts"],
            tags: ["test", "search"],
          },
        ]),
    };

    // Create spies for all methods
    listRulesSpy = spyOn(mockRuleService, "listRules");
    getRuleSpy = spyOn(mockRuleService, "getRule");
    createRuleSpy = spyOn(mockRuleService, "createRule");
    updateRuleSpy = spyOn(mockRuleService, "updateRule");
    searchRulesSpy = spyOn(mockRuleService, "searchRules");

    // Mock the RuleService module to use our mock
    mock.module("../../../../domain/rules.js", () => ({
      RuleService: class MockRuleService {
        constructor() {
          return mockRuleService;
        }
      },
    }));

    // Clear the registry for testing
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Reset all mocks for clean tests
    mock.restore();
  });

  test("registerRulesCommands should register rules commands in registry", () => {
    // Register commands
    registerRulesCommands();

    // Verify commands were registered
    const rulesCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES);
    expectToHaveLength(rulesCommands, 5);

    // Verify individual commands
    const expectedCommands = [
      "rules.list",
      "rules.get",
      "rules.create",
      "rules.update",
      "rules.search",
    ];

    expectedCommands.forEach((cmdId) => {
      const command = sharedCommandRegistry.getCommand(cmdId);
      expect(command).toBeDefined();
      expect(command?.category).toBe(CommandCategory.RULES);
    });
  });

  test("rules.list command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();

    // Get command
    const listCommand = sharedCommandRegistry.getCommand("rules.list");
    expect(listCommand).toBeDefined();

    // Execute command
    const params = {
      format: "cursor",
      tag: "test",
      debug: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await listCommand!.execute(params, context);

    // Verify workspace path resolution was called
    expectToHaveBeenCalled(resolveWorkspacePathSpy);

    // Verify domain function was called with correct params
    expectToHaveBeenCalled(listRulesSpy);

    // Verify result
    expect(result.success).toBe(true);
    expectToBeInstanceOf(result.rules, Array);

    // Validate contents
    expectToHaveLength(result.rules, 2);
    expect(result.rules[0].id).toBe("test-rule-1");
    expect(result.rules[0].name).toBe("Test Rule 1");
    expect(result.rules[1].id).toBe("test-rule-2");
    expect(result.rules[1].name).toBe("Test Rule 2");
  });

  test("rules.get command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();

    // Get command
    const getCommand = sharedCommandRegistry.getCommand("rules.get");
    expect(getCommand).toBeDefined();

    // Execute command
    const params = {
      id: "test-rule",
      format: "cursor",
      debug: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await getCommand!.execute(params, context);

    // Verify workspace path resolution was called
    expectToHaveBeenCalled(resolveWorkspacePathSpy);

    // Verify getRule was called with the right ID
    expectToHaveBeenCalled(getRuleSpy);
    expect(getMockCallArg(getRuleSpy, 0, 0)).toBe("test-rule");

    // Verify result
    expect(result.success).toBe(true);
    expect(typeof result.rule).toBe("object");
    expect(result.rule.id).toBe("test-rule");
    expect(result.rule.format).toBe("cursor");
  });

  test("rules.create command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();

    // Get command
    const createCommand = sharedCommandRegistry.getCommand("rules.create");
    expect(createCommand).toBeDefined();

    // Execute command
    const params = {
      id: "test-rule-new",
      name: "Test Rule New",
      description: "Test rule description",
      content: "content-file.md",
      format: "cursor",
      globs: "*.ts,*.js",
      tags: "test,new",
      debug: true,
      workspace: "/custom/workspace",
      json: true,
    };
    const context = { interface: "test" };
    const result = await createCommand!.execute(params, context);

    // Verify workspace path resolution was called
    expectToHaveBeenCalled(resolveWorkspacePathSpy);

    // Verify domain function was called
    expectToHaveBeenCalled(createRuleSpy);

    // Check first argument is the rule ID
    expect(getMockCallArg(createRuleSpy, 0, 0)).toBe("test-rule-new");

    // Verify result
    expect(result.success).toBe(true);
    expect(typeof result.rule).toBe("object");
    expect(result.rule.id).toBe("test-rule-new");
    expect(result.rule.name).toBe("Test Rule New");
  });

  test("rules.update command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();

    // Get command
    const updateCommand = sharedCommandRegistry.getCommand("rules.update");
    expect(updateCommand).toBeDefined();

    // Execute command
    const params = {
      id: "existing-rule",
      content: "# Updated Rule Content",
      description: "Updated rule description",
      name: "Updated Rule Name",
      globs: "*.md,*.mdx",
      tags: "markdown,docs",
      format: "cursor",
      debug: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await updateCommand!.execute(params, context);

    // Verify workspace path resolution was called
    expectToHaveBeenCalled(resolveWorkspacePathSpy);

    // Verify updateRule was called with the right rule ID
    expectToHaveBeenCalled(updateRuleSpy);
    expect(getMockCallArg(updateRuleSpy, 0, 0)).toBe("existing-rule");

    // Verify result
    expect(result.success).toBe(true);
    expect(typeof result.rule).toBe("object");
    expect(result.rule.id).toBe("existing-rule");
  });

  test("rules.search command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();

    // Get command
    const searchCommand = sharedCommandRegistry.getCommand("rules.search");
    expect(searchCommand).toBeDefined();

    // Execute command
    const params = {
      query: "search",
      format: "cursor",
      tag: "test",
      debug: true,
      json: true,
    };
    const context = { interface: "test" };
    const result = await searchCommand!.execute(params, context);

    // Verify workspace path resolution was called
    expectToHaveBeenCalled(resolveWorkspacePathSpy);

    // Verify searchRules was called with appropriate params
    expectToHaveBeenCalled(searchRulesSpy);

    // Verify result
    expect(result.success).toBe(true);
    expectToBeInstanceOf(result.rules, Array);
    expect(result.query).toBe("search");
    expect(result.matchCount).toBe(1);
    expectToHaveLength(result.rules, 1);
    expect(result.rules[0].id).toBe("test-search-rule");
  });
});
