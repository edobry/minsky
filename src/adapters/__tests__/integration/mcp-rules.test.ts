/**
 * MCP Rules Adapter Integration Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports with improved mocking
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CommandMapper } from "../../../mcp/command-mapper.ts";
import { registerRulesTools } from "../../../adapters/mcp/rules.ts";
import * as workspace from "../../../domain/workspace.ts";
import * as rulesDomain from "../../../domain/rules.ts";
import { createMock, mockModule, setupTestMocks, spyOn } from "../../../utils/test-utils/mocking.ts";
import { expectToHaveBeenCalled, expectToHaveBeenCalledWith } from "../../../utils/test-utils/assertions.ts";

// Set up automatic mock cleanup
setupTestMocks();

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
  
  // Mock command mapper with proper server mock
  let commandMapper: CommandMapper;
  let addCommandSpy: any;
  let mockServer: any;
  
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
      listRules: createMock((options?: any) => Promise.resolve(mockRules)),
      getRule: createMock((id: string, options?: any) =>
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
      createRule: createMock((id: string, content: string, meta: any, options?: any) =>
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
      updateRule: createMock((id: string, updates: any, options?: any) =>
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
      searchRules: createMock((options?: any) =>
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
    
    // Create a proper mock server for CommandMapper
    mockServer = {
      addTool: createMock(() => {}),
    };
    
    // Set up command mapper with mocked server
    commandMapper = new CommandMapper();
    // @ts-ignore - Override private property for testing
    commandMapper.server = mockServer;
    addCommandSpy = spyOn(commandMapper, "addCommand");
  });

  test("rules.list command should register with CommandMapper", () => {
    // Register tools
    registerRulesTools(commandMapper);
    
    // Verify the command was registered using our helper
    expectToHaveBeenCalled(addCommandSpy);
    
    // Check that rules.list was one of the registered commands
    const callArgs = addCommandSpy.mock.calls;
    const rulesListCall = callArgs.find((call: any) => call[0]?.name === "rules.list");
    expect(rulesListCall).toBeDefined();
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
    
    // Verify domain functions were called using our helpers
    expectToHaveBeenCalledWith(resolveWorkspacePathSpy, {});
    expectToHaveBeenCalledWith(ruleServiceConstructorSpy, "/test/workspace");
    expectToHaveBeenCalledWith(listRulesSpy, {
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
    
    // Verify domain functions were called using our helpers
    expectToHaveBeenCalledWith(resolveWorkspacePathSpy, {});
    expectToHaveBeenCalledWith(ruleServiceConstructorSpy, "/test/workspace");
    expectToHaveBeenCalledWith(getRuleSpy, "test-rule", {
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
