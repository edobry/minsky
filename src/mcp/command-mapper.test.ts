import { describe, expect, test, mock, spyOn } from "bun:test";
import { CommandMapper } from "./command-mapper.js";
import { z } from "zod";
import type { ProjectContext } from "../types/project.js";

// Mock FastMCP
const mockServer = {
  addTool: mock.fn(),
};

describe("CommandMapper", () => {
  describe("constructor", () => {
    test("initializes with project context", () => {
      // Create a mock project context
      const mockProjectContext: ProjectContext = {
        repositoryPath: "/mock/repo/path"
      };
      
      // Create a CommandMapper instance with the mock project context
      const mapper = new CommandMapper(mockServer as any, mockProjectContext);
      
      // Check if the project context is correctly stored
      expect(mapper.getProjectContext()).toEqual(mockProjectContext);
    });
  });
  
  describe("addCommand", () => {
    test("injects repository path from project context when missing in args", async () => {
      // Create a mock project context
      const mockProjectContext: ProjectContext = {
        repositoryPath: "/mock/repo/path"
      };
      
      // Create a test execute function that returns the args
      const executeFunction = mock.fn((args) => Promise.resolve(args));
      
      // Create a CommandMapper instance with the mock project context
      const mapper = new CommandMapper(mockServer as any, mockProjectContext);
      
      // Add a command using our test execute function
      mapper.addCommand({
        name: "test.command",
        description: "Test command",
        parameters: z.object({
          testParam: z.string()
        }),
        execute: executeFunction
      });
      
      // Get the callback function that was registered with addTool
      const executeFn = mockServer.addTool.mock.calls[0].arguments[0].execute;
      
      // Call the execute function with args missing repositoryPath
      await executeFn({ testParam: "test value" });
      
      // Check if our execute function received args with the injected repositoryPath
      const args = executeFunction.mock.calls[0].arguments[0];
      expect(args).toHaveProperty("repositoryPath", "/mock/repo/path");
      expect(args).toHaveProperty("testParam", "test value");
    });
    
    test("preserves explicit repositoryPath in args", async () => {
      // Create a mock project context
      const mockProjectContext: ProjectContext = {
        repositoryPath: "/mock/repo/path"
      };
      
      // Create a test execute function that returns the args
      const executeFunction = mock.fn((args) => Promise.resolve(args));
      
      // Create a CommandMapper instance with the mock project context
      const mapper = new CommandMapper(mockServer as any, mockProjectContext);
      
      // Add a command using our test execute function
      mapper.addCommand({
        name: "test.command",
        description: "Test command",
        parameters: z.object({
          testParam: z.string(),
          repositoryPath: z.string().optional()
        }),
        execute: executeFunction
      });
      
      // Get the callback function that was registered with addTool
      const executeFn = mockServer.addTool.mock.calls[0].arguments[0].execute;
      
      // Call the execute function with explicit repositoryPath
      await executeFn({ 
        testParam: "test value",
        repositoryPath: "/explicit/repo/path"
      });
      
      // Check if our execute function received args with the original repositoryPath
      const args = executeFunction.mock.calls[0].arguments[0];
      expect(args).toHaveProperty("repositoryPath", "/explicit/repo/path");
      expect(args).toHaveProperty("testParam", "test value");
    });
  });
  
  describe("addTaskCommand", () => {
    test("extends parameters to include optional repositoryPath", () => {
      // Mock the addCommand method
      const addCommandSpy = mock.fn();
      const mapper = new CommandMapper(mockServer as any);
      mapper.addCommand = addCommandSpy;
      
      // Call addTaskCommand with parameters that don't include repositoryPath
      mapper.addTaskCommand(
        "test",
        "Test task command",
        z.object({ testParam: z.string() }),
        async () => "test result"
      );
      
      // Check if addCommand was called with extended parameters
      const addCommandArgs = addCommandSpy.mock.calls[0].arguments[0];
      const parameters = addCommandArgs.parameters;
      
      // Verify the parameters were extended to include repositoryPath
      expect(parameters.shape).toHaveProperty("repositoryPath");
    });
    
    test("preserves existing repositoryPath parameter", () => {
      // Mock the addCommand method
      const addCommandSpy = mock.fn();
      const mapper = new CommandMapper(mockServer as any);
      mapper.addCommand = addCommandSpy;
      
      // Call addTaskCommand with parameters that already include repositoryPath
      mapper.addTaskCommand(
        "test",
        "Test task command",
        z.object({ 
          testParam: z.string(),
          repositoryPath: z.string().describe("Original description")
        }),
        async () => "test result"
      );
      
      // Check if addCommand was called with the original parameters
      const addCommandArgs = addCommandSpy.mock.calls[0].arguments[0];
      const parameters = addCommandArgs.parameters;
      
      // Verify the original parameters were preserved
      expect(parameters).toHaveProperty("shape.repositoryPath");
      expect(parameters.shape.repositoryPath.description).toEqual("Original description");
    });
  });
}); 
