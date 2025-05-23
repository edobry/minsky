/**
 * MCP Rules Adapter Tests
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { CommandMapper } from "../../../mcp/command-mapper.js";
import { registerRulesTools } from "../../../adapters/mcp/rules.js";
import * as workspace from "../../../domain/workspace.js";
import * as rulesDomain from "../../../domain/rules.js";

// Define interfaces for mock object types
interface MockRuleService {
  listRules: (options?: any) => Promise<any[]>;
  getRule: (id: string, options?: any) => Promise<any>;
  createRule: (id: string, content: string, meta: any, options?: any) => Promise<any>;
  updateRule: (id: string, updates: any, options?: any) => Promise<any>;
  searchRules: (options?: any) => Promise<any[]>;
}

describe("MCP Rules Adapter", () => {
  // Set up spies for domain functions
  let resolveWorkspacePathSpy: any;
  let listRulesSpy: any;
  let getRuleSpy: any;
  let ruleServiceConstructorSpy: any;
  
  // Mock command mapper
  let commandMapper: CommandMapper;
  let addCommandSpy: any;
  
  // Mock rule data
  const mockRules = [
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
  ];

  beforeEach(() => {
    // Set up spy for workspace path resolution
    resolveWorkspacePathSpy = spyOn(workspace, "resolveWorkspacePath");
    resolveWorkspacePathSpy.mockImplementation(() => Promise.resolve("/test/workspace"));

    // Create mock object for methods
    const mockMethods: MockRuleService = {
      listRules: mock((options?: any) => Promise.resolve(mockRules)),
      getRule: mock((id: string, options?: any) =>
        Promise.resolve({
          id,
          name: `Rule ${id}`,
          description: `Description for rule ${id}`,
          content: `# Content for rule ${id}`,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: ["*.ts"],
          tags: ["test"]
        })
      ),
      createRule: mock((id: string, content: string, meta: any, options?: any) =>
        Promise.resolve({
          id,
          name: meta.name,
          description: meta.description,
          content,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: meta.globs,
          tags: meta.tags
        })
      ),
      updateRule: mock((id: string, updates: any, options?: any) =>
        Promise.resolve({
          id,
          name: updates.meta?.name || `Rule ${id}`,
          description: updates.meta?.description || `Description for rule ${id}`,
          content: updates.content || `# Content for rule ${id}`,
          format: options?.format || "cursor",
          path: `/test/workspace/.cursor/rules/${id}.mdc`,
          globs: updates.meta?.globs || ["*.ts"],
          tags: updates.meta?.tags || ["test"]
        })
      ),
      searchRules: mock((options?: any) =>
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
      )
    };
    
    // Create spies for methods
    listRulesSpy = mockMethods.listRules;
    getRuleSpy = mockMethods.getRule;
    
    // Create a spy for the RuleService constructor
    ruleServiceConstructorSpy = spyOn(rulesDomain, "RuleService");
    ruleServiceConstructorSpy.mockImplementation(() => mockMethods);
    
    // Set up command mapper mock
    commandMapper = new CommandMapper();
    addCommandSpy = spyOn(commandMapper, "addCommand");
  });

  test("rules.list command should register with CommandMapper", () => {
    // Register tools
    registerRulesTools(commandMapper);
    
    // Verify the command was registered
    expect(addCommandSpy).toHaveBeenCalledWith(expect.objectContaining({
      name: "rules.list"
    }));
  });

  test("rules.list command excludes content by default", async () => {
    // Register tools
    registerRulesTools(commandMapper);
    
    // Get the execute function from the rules.list registration
    const listCommandCall = addCommandSpy.mock.calls.find(
      (call: any) => call[0].name === "rules.list"
    );
    expect(listCommandCall).toBeDefined();
    
    // Extract the execute function
    const executeFunction = listCommandCall[0].execute;
    
    // Call the execute function with default parameters
    const result = await executeFunction({
      format: "cursor",
      tag: "test",
      debug: true
    });
    
    // Verify domain functions were called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    expect(listRulesSpy).toHaveBeenCalledWith({
      format: "cursor",
      tag: "test",
      debug: true
    });
    
    // Verify that content is excluded from the result
    expect(result).toHaveProperty("rules");
    expect(Array.isArray(result.rules)).toBe(true);
    expect(result.rules.length).toBe(2);
    
    // Check that content is not present in any rule
    for (const rule of result.rules) {
      expect(rule).not.toHaveProperty("content");
      
      // Verify other properties are present
      expect(rule).toHaveProperty("id");
      expect(rule).toHaveProperty("name");
      expect(rule).toHaveProperty("description");
      expect(rule).toHaveProperty("format");
      expect(rule).toHaveProperty("path");
    }
  });

  test("rules.list command includes content when includeContent=true", async () => {
    // Register tools
    registerRulesTools(commandMapper);
    
    // Get the execute function from the rules.list registration
    const listCommandCall = addCommandSpy.mock.calls.find(
      (call: any) => call[0].name === "rules.list"
    );
    expect(listCommandCall).toBeDefined();
    
    // Extract the execute function
    const executeFunction = listCommandCall[0].execute;
    
    // Call the execute function with includeContent=true
    const result = await executeFunction({
      format: "cursor",
      tag: "test",
      debug: true,
      includeContent: true
    });
    
    // Verify domain functions were called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    expect(listRulesSpy).toHaveBeenCalledWith({
      format: "cursor",
      tag: "test",
      debug: true
    });
    
    // Verify that content is included in the result
    expect(result).toHaveProperty("rules");
    expect(Array.isArray(result.rules)).toBe(true);
    expect(result.rules.length).toBe(2);
    
    // Check that content is present in every rule
    for (const rule of result.rules) {
      expect(rule).toHaveProperty("content");
      expect(typeof rule.content).toBe("string");
      
      // Verify other properties are also present
      expect(rule).toHaveProperty("id");
      expect(rule).toHaveProperty("name");
      expect(rule).toHaveProperty("description");
      expect(rule).toHaveProperty("format");
      expect(rule).toHaveProperty("path");
    }
  });

  test("rules.get command always includes content", async () => {
    // Register tools
    registerRulesTools(commandMapper);
    
    // Get the execute function from the rules.get registration
    const getCommandCall = addCommandSpy.mock.calls.find(
      (call: any) => call[0].name === "rules.get"
    );
    expect(getCommandCall).toBeDefined();
    
    // Extract the execute function
    const executeFunction = getCommandCall[0].execute;
    
    // Call the execute function
    const result = await executeFunction({
      id: "test-rule",
      format: "cursor",
      debug: true
    });
    
    // Verify domain functions were called
    expect(resolveWorkspacePathSpy).toHaveBeenCalledWith({});
    expect(ruleServiceConstructorSpy).toHaveBeenCalledWith("/test/workspace");
    expect(getRuleSpy).toHaveBeenCalledWith("test-rule", {
      format: "cursor",
      debug: true
    });
    
    // Verify that content is included in the result
    expect(result).toHaveProperty("rule");
    expect(result.rule).toHaveProperty("content");
    expect(typeof result.rule.content).toBe("string");
    
    // Verify other properties are also present
    expect(result.rule).toHaveProperty("id");
    expect(result.rule).toHaveProperty("name");
    expect(result.rule).toHaveProperty("description");
    expect(result.rule).toHaveProperty("format");
    expect(result.rule).toHaveProperty("path");
  });
}); 
