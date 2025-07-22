import { describe, test, expect, beforeEach } from "bun:test";
import { 
  getCommandRepresentation, 
  getCommandSyntax,
  getCommandsByCategory,
  getParameterDocumentation,
  createCommandGeneratorService,
  type CommandGenerationConfig
} from "./command-generator";
import { 
  sharedCommandRegistry, 
  CommandCategory
} from "../../adapters/shared/command-registry";

// Mock the shared command registry with proper Bun mock syntax
jest.mock("../../adapters/shared/command-registry", () => {
  const mockRegistry = {
    getCommand: jest.fn(),
    getCommandsByCategory: jest.fn(),
    hasCommand: jest.fn(),
    getAllCommands: jest.fn(),
  };
  
  return {
    sharedCommandRegistry: mockRegistry,
    CommandCategory: {
      TASKS: "TASKS",
      GIT: "GIT",
      SESSION: "SESSION"
    }
  };
});

describe("CommandGenerator", () => {
  beforeEach(() => {
    // Reset mocks before each test
    const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
    getCommandMock.mockReset();
    
    const getCommandsByCategoryMock = sharedCommandRegistry.getCommandsByCategory as jest.Mock;
    getCommandsByCategoryMock.mockReset();
  });
  
  describe("getCommandRepresentation", () => {
    test("should return null for unknown command", () => {
      // Mock command not found
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue(null);
      
      const result = getCommandRepresentation("unknown.command");
      expect(result).toBeNull();
    });
    
    test("should return proper representation for known command", () => {
      // Mock command found
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue({
        id: "tasks.list",
        category: CommandCategory.TASKS,
        description: "List all tasks",
        parameters: {
          all: {
            schema: {} as any,
            description: "Include all tasks",
            required: false,
            defaultValue: false
          },
          limit: {
            schema: {} as any,
            description: "Limit results",
            required: false
          }
        }
      });
      
      const result = getCommandRepresentation("tasks.list");
      expect(result).not.toBeNull();
      if (result) {
        expect(result.id).toBe("tasks.list");
        expect(result.category).toBe(CommandCategory.TASKS);
        expect(result.description).toBe("List all tasks");
        expect(result.cliSyntax).toBe("minsky tasks list [--all] [--limit <value>]");
        expect(result.mcpSyntax).toContain("mcp_minsky_server_tasks.list(");
        expect(result.parameters).toHaveLength(2);
      }
    });
  });
  
  describe("getCommandSyntax", () => {
    let mockCommand: any;
    
    beforeEach(() => {
      // Setup a mock command
      mockCommand = {
        id: "tasks.list",
        category: CommandCategory.TASKS,
        description: "List all tasks",
        parameters: {
          all: {
            schema: {} as any,
            description: "Include all tasks",
            required: false,
            defaultValue: false
          },
          limit: {
            schema: {} as any,
            description: "Limit results",
            required: false
          }
        }
      };
      
      // Mock command found
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue(mockCommand);
    });
    
    test("should return CLI syntax in CLI mode", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false
      };
      
      const result = getCommandSyntax("tasks.list", config);
      expect(result).toBe("minsky tasks list [--all] [--limit <value>]");
    });
    
    test("should return MCP syntax in MCP mode", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "mcp",
        mcpEnabled: true,
        preferMcp: true
      };
      
      const result = getCommandSyntax("tasks.list", config);
      expect(result).toContain("mcp_minsky_server_tasks.list(");
    });
    
    test("should return CLI syntax in hybrid mode when preferMcp is false", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "hybrid",
        mcpEnabled: true,
        preferMcp: false
      };
      
      const result = getCommandSyntax("tasks.list", config);
      expect(result).toBe("minsky tasks list [--all] [--limit <value>]");
    });
    
    test("should return MCP syntax in hybrid mode when preferMcp is true", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "hybrid",
        mcpEnabled: true,
        preferMcp: true
      };
      
      const result = getCommandSyntax("tasks.list", config);
      expect(result).toContain("mcp_minsky_server_tasks.list(");
    });
  });
  
  describe("getCommandsByCategory", () => {
    test("should return list of command representations for a category", () => {
      // Mock commands for category
      const getCommandsByCategoryMock = sharedCommandRegistry.getCommandsByCategory as jest.Mock;
      getCommandsByCategoryMock.mockReturnValue([
        {
          id: "tasks.list",
          category: CommandCategory.TASKS,
          description: "List all tasks",
          parameters: {}
        },
        {
          id: "tasks.get",
          category: CommandCategory.TASKS,
          description: "Get task by ID",
          parameters: {
            taskId: {
              schema: {} as any,
              description: "Task ID",
              required: true
            }
          }
        }
      ]);
      
      const results = getCommandsByCategory(CommandCategory.TASKS);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("tasks.list");
      expect(results[0].cliSyntax).toBe("minsky tasks list");
      expect(results[1].id).toBe("tasks.get");
      expect(results[1].cliSyntax).toBe("minsky tasks get <taskId>");
    });
  });
  
  describe("getParameterDocumentation", () => {
    test("should return parameter documentation for a command", () => {
      // Mock command found
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue({
        id: "tasks.get",
        category: CommandCategory.TASKS,
        description: "Get task by ID",
        parameters: {
          taskId: {
            schema: {} as any,
            description: "Task ID",
            required: true
          },
          format: {
            schema: {} as any,
            description: "Output format",
            required: false,
            defaultValue: "text"
          }
        }
      });
      
      const docs = getParameterDocumentation("tasks.get");
      expect(docs).toContain("Task ID");
      expect(docs).toContain("Required");
      expect(docs).toContain("Output format");
      expect(docs).toContain("Optional");
      expect(docs).toContain("Default: `text`");
    });
    
    test("should handle no parameters", () => {
      // Mock command found with no parameters
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue({
        id: "tasks.list",
        category: CommandCategory.TASKS,
        description: "List all tasks",
        parameters: {}
      });
      
      const docs = getParameterDocumentation("tasks.list");
      expect(docs).toContain("No parameters available");
    });
  });
  
  describe("CommandGeneratorService", () => {
    test("should create service with initial config", () => {
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false
      };
      
      const service = createCommandGeneratorService(config);
      expect(service).toBeDefined();
    });
    
    test("should update config", () => {
      // Setup
      const mockCommand = {
        id: "tasks.list",
        category: CommandCategory.TASKS,
        description: "List all tasks",
        parameters: {}
      };
      
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockReturnValue(mockCommand);
      
      // Initial config - CLI mode
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false
      };
      
      const service = createCommandGeneratorService(config);
      
      // Check CLI syntax
      const cliSyntax = service.getCommandSyntax("tasks.list");
      expect(cliSyntax).toBe("minsky tasks list");
      
      // Update config to MCP mode
      service.updateConfig({ interfaceMode: "mcp" });
      
      // Check MCP syntax
      const mcpSyntax = service.getCommandSyntax("tasks.list");
      if (mcpSyntax) {
        expect(mcpSyntax).toContain("mcp_minsky_server_tasks.list");
      }
    });
    
    test("should get commands by category", () => {
      // Mock commands for category
      const getCommandsByCategoryMock = sharedCommandRegistry.getCommandsByCategory as jest.Mock;
      getCommandsByCategoryMock.mockReturnValue([
        {
          id: "tasks.list",
          category: CommandCategory.TASKS,
          description: "List all tasks",
          parameters: {}
        },
        {
          id: "tasks.get",
          category: CommandCategory.TASKS,
          description: "Get task by ID",
          parameters: {
            taskId: {
              schema: {} as any,
              description: "Task ID",
              required: true
            }
          }
        }
      ]);
      
      // Mock getCommand for each individual command
      const getCommandMock = sharedCommandRegistry.getCommand as jest.Mock;
      getCommandMock.mockImplementation((id) => {
        if (id === "tasks.list") {
          return {
            id: "tasks.list",
            category: CommandCategory.TASKS,
            description: "List all tasks",
            parameters: {}
          };
        }
        if (id === "tasks.get") {
          return {
            id: "tasks.get",
            category: CommandCategory.TASKS,
            description: "Get task by ID",
            parameters: {
              taskId: {
                schema: {} as any,
                description: "Task ID",
                required: true
              }
            }
          };
        }
        return null;
      });
      
      const config: CommandGenerationConfig = {
        interfaceMode: "cli",
        mcpEnabled: false,
        preferMcp: false
      };
      
      const service = createCommandGeneratorService(config);
      const commands = service.getCommandsByCategory(CommandCategory.TASKS);
      
      expect(commands).toHaveLength(2);
      expect(commands[0].id).toBe("tasks.list");
      expect(commands[0].syntax).toBe("minsky tasks list");
      expect(commands[1].id).toBe("tasks.get");
      expect(commands[1].syntax).toBe("minsky tasks get <taskId>");
    });
  });
}); 
