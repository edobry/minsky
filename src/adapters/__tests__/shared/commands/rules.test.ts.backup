/**
 * Shared Rules Commands Tests
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registerRulesCommands } from "../../../../adapters/shared/commands/rules.js";
import {
  sharedCommandRegistry,
  CommandCategory,
} from "../../../../adapters/shared/command-registry.js";
import * as workspace from "../../../../domain/workspace.js";
import * as rulesDomain from "../../../../domain/rules.js";

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
  let ruleServiceConstructorSpy: ReturnType<typeof spyOn>;
  
  // Mock for CLI rules module
  let mockReadContentFromFileIfExists: any;

  beforeEach(() => {
    // Mock CLI rules adapter - we'll handle this at test level
    mockReadContentFromFileIfExists = spyOn(null, "readContentFromFileIfExists").mockImplementation((path) => {
      return "# Rule Content from File";
    });

    // Set up spy for workspace path resolution
    resolveWorkspacePathSpy = spyOn(workspace, "resolveWorkspacePath").mockImplementation(() =>
      Promise.resolve("/test/workspace")
    );

    // Create mock object for methods
    const mockMethods: MockRuleService = {
      listRules: (options?: any) =>
        Promise.resolve([
          {
            id: "test-rule-1",
            name: "Test Rule 1",
            description: "Test rule 1 description",
            content: "# Test Rule 1 Content",
            format: "cursor",
            path: "/test/workspace/.cursor/rules/test-rule-1.mdc",
            globs: ["*.ts"],
            tags: ["test"]
          },
          {
            id: "test-rule-2",
            name: "Test Rule 2",
            description: "Test rule 2 description",
            content: "# Test Rule 2 Content",
            format: "generic",
            path: "/test/workspace/.ai/rules/test-rule-2.mdc",
            globs: ["*.md"],
            tags: ["docs"]
          }
        ]),
      getRule: (id: string, options?: any) =>
        Promise.resolve({
          id,
          name: `Rule ${id}`,
          description: `Description for rule ${id}`,
          content: `# Content for rule ${id}`,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: ["*.ts"],
          tags: ["test"]
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
          tags: meta.tags
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
          tags: updates.meta?.tags || ["test"]
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
            tags: ["test", "search"]
          }
        ])
    };
    
    // Create spies for all methods
    listRulesSpy = spyOn(mockMethods, "listRules");
    getRuleSpy = spyOn(mockMethods, "getRule");
    createRuleSpy = spyOn(mockMethods, "createRule");
    updateRuleSpy = spyOn(mockMethods, "updateRule");
    searchRulesSpy = spyOn(mockMethods, "searchRules");
    
    // Create a spy for the RuleService constructor
    ruleServiceConstructorSpy = spyOn(rulesDomain, "RuleService").mockImplementation(() => {
      // Return the mock object with the spies
      return mockMethods;
    });
    
    // Clear the registry for testing
    (sharedCommandRegistry as any).commands = new Map();
  });

  afterEach(() => {
    // Reset original functions
    resolveWorkspacePathSpy.mockReset();
    ruleServiceConstructorSpy.mockReset();
    listRulesSpy.mockReset();
    getRuleSpy.mockReset();
    createRuleSpy.mockReset();
    updateRuleSpy.mockReset();
    searchRulesSpy.mockReset();
  });

  test("registerRulesCommands should register rules commands in registry", () => {
    // Register commands
    registerRulesCommands();
    
    // Verify commands were registered
    const rulesCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES);
    expect(rulesCommands.length).toBe(5);
    
    // Verify individual commands
    const expectedCommands = [
      "rules.list",
      "rules.get",
      "rules.create",
      "rules.update",
      "rules.search"
    ];
    
    expectedCommands.forEach(cmdId => {
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
      json: true
    };
    const context = { interface: "test" };
    const result = await listCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify domain function was called with correct params
    expect(listRulesSpy).toHaveBeenCalledWith({
      format: "cursor",
      tag: "test",
      debug: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rules: expect.any(Array)
    });

    // Validate contents instead of using arrayContaining
    expect(result.rules.length).toBe(2);
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
      json: true
    };
    const context = { interface: "test" };
    const result = await getCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify getRule was called with correct params
    expect(getRuleSpy).toHaveBeenCalledWith("test-rule", {
      format: "cursor",
      debug: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rule: expect.any(Object)
    });
    expect(result.rule.id).toBe("test-rule");
    expect(result.rule.format).toBe("cursor");
  });

  test("rules.create command should call domain function with correct params", async () => {
    // Register commands
    registerRulesCommands();
    
    // Get command
    const createCommand = sharedCommandRegistry.getCommand("rules.create");
    expect(createCommand).toBeDefined();
    
    // Set up mock for content file reading
    mockReadContentFromFileIfExists.mockReturnValue("# Rule Content from File");
    
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
      json: true
    };
    const context = { interface: "test" };
    const result = await createCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({
      workspace: "/custom/workspace" 
    });
    
    // Verify content file was read
    expect(mockReadContentFromFileIfExists).toHaveBeenCalledWith("content-file.md");
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify domain function was called with correct params
    expect(createRuleSpy).toHaveBeenCalledWith(
      "test-rule-new",
      "# Rule Content from File",
      {
        name: "Test Rule New",
        description: "Test rule description",
        globs: ["*.ts", "*.js"],
        tags: ["test", "new"]
      },
      {
        format: "cursor",
        debug: true
      }
    );
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rule: expect.any(Object)
    });
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
      json: true
    };
    const context = { interface: "test" };
    const result = await updateCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify updateRule was called with correct params
    expect(updateRuleSpy).toHaveBeenCalledWith(
      "existing-rule",
      expect.objectContaining({
        content: "# Updated Rule Content",
        meta: expect.any(Object)
      }),
      {
        format: "cursor",
        debug: true
      }
    );
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rule: expect.any(Object)
    });
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
      json: true
    };
    const context = { interface: "test" };
    const result = await searchCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify searchRules was called with correct params
    expect(searchRulesSpy).toHaveBeenCalledWith({
      query: "search",
      format: "cursor",
      tag: "test"
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rules: expect.any(Array),
      query: "search",
      matchCount: 1
    });
    expect(result.rules.length).toBe(1);
    expect(result.rules[0].id).toBe("test-search-rule");
  });
}); 
