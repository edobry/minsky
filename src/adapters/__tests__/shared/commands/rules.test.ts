/**
 * Shared Rules Commands Tests
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registerRulesCommands } from "../../../../adapters/shared/commands/rules.js";
import { sharedCommandRegistry, CommandCategory } from "../../../../adapters/shared/command-registry.js";
import * as workspace from "../../../../domain/workspace.js";
import * as rulesDomain from "../../../../domain/rules.js";

// Custom matcher helper functions
const arrayContaining = (arr: any[]) => ({
  asymmetricMatch: (actual: any[]) => 
    Array.isArray(actual) && 
    arr.every(item => 
      actual.some(actualItem => 
        JSON.stringify(actualItem).includes(JSON.stringify(item))
      )
    )
});

const objectContaining = (obj: Record<string, any>) => ({
  asymmetricMatch: (actual: Record<string, any>) => 
    typeof actual === 'object' && 
    Object.entries(obj).every(([key, value]) => 
      key in actual && JSON.stringify(actual[key]).includes(JSON.stringify(value))
    )
});

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
  
  beforeEach(() => {
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
    // Restore original functions
    resolveWorkspacePathSpy.mockRestore();
    ruleServiceConstructorSpy.mockRestore();
    listRulesSpy.mockRestore();
    getRuleSpy.mockRestore();
    createRuleSpy.mockRestore();
    updateRuleSpy.mockRestore();
    searchRulesSpy.mockRestore();
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
    
    // Verify listRules was called with correct params
    expect(listRulesSpy).toHaveBeenCalledWith({
      format: "cursor",
      tag: "test",
      debug: true
    });
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rules: arrayContaining([
        objectContaining({
          id: "test-rule-1"
        }),
        objectContaining({
          id: "test-rule-2"
        })
      ])
    });
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
    
    // Mock readContentFromFileIfExists to avoid fs dependency in tests
    jest.mock("../../../../adapters/cli/rules.js", () => ({
      readContentFromFileIfExists: jest.fn((content) => Promise.resolve(content)),
      parseGlobs: jest.fn((globs) => globs?.split(",") || undefined)
    }));
    
    // Execute command
    const params = {
      id: "new-rule",
      content: "# New Rule Content",
      description: "New rule description",
      name: "New Rule Name",
      globs: "*.ts,*.tsx",
      tags: "typescript,react",
      format: "cursor",
      overwrite: true,
      json: true
    };
    const context = { interface: "test" };
    const result = await createCommand!.execute(params, context);
    
    // Verify workspace path resolution was called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    
    // Verify RuleService was constructed with correct workspace path
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    
    // Verify createRule was called with correct params
    expect(createRuleSpy).toHaveBeenCalledWith(
      "new-rule",
      "# New Rule Content",
      expect.objectContaining({
        name: "New Rule Name",
        description: "New rule description",
      }),
      {
        format: "cursor",
        overwrite: true
      }
    );
    
    // Verify result
    expect(result).toEqual({
      success: true,
      rule: expect.any(Object)
    });
    expect(result.rule.id).toBe("new-rule");
    expect(result.rule.name).toBe("New Rule Name");
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
