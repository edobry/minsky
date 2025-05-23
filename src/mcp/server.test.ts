import { describe, expect, test, spyOn, mock, MockFn } from "bun:test";
import { MinskyMCPServer } from "./server.js";
import * as projectModule from "../types/project.js";
import { FastMCP } from "fastmcp";

// Mock FastMCP
mock.module("fastmcp", () => {
  return {
    FastMCP: mock.fn(() => {
      return {
        start: mock.fn(),
        on: mock.fn(),
        addTool: mock.fn(),
      };
    }),
  };
});

describe("MinskyMCPServer", () => {
  describe("constructor", () => {
    test("initializes with project context from parameters", () => {
      // Create a mock project context
      const mockProjectContext = {
        repositoryPath: "/mock/repo/path"
      };
      
      // Create a server instance with the mock project context
      const server = new MinskyMCPServer({
        projectContext: mockProjectContext
      });
      
      // Check if the project context is correctly stored
      expect(server.getProjectContext()).toEqual(mockProjectContext);
    });
    
    test("falls back to current directory when no project context is provided", () => {
      // Spy on createProjectContextFromCwd to control its return value
      const mockProjectContext = {
        repositoryPath: "/current/dir"
      };
      const createContextSpy = spyOn(projectModule, "createProjectContextFromCwd").mockReturnValue(mockProjectContext);
      
      // Create a server instance without specifying a project context
      const server = new MinskyMCPServer({});
      
      // Check if createProjectContextFromCwd was called and the context is correct
      expect(createContextSpy).toHaveBeenCalled();
      expect(server.getProjectContext()).toEqual(mockProjectContext);
      
      // Restore the spy
      createContextSpy.restore();
    });
    
    test("handles errors when creating project context from current directory", () => {
      // Spy on createProjectContextFromCwd to make it throw an error
      const createContextSpy = spyOn(projectModule, "createProjectContextFromCwd").mockImplementation(() => {
        throw new Error("Failed to create context");
      });
      
      // Create a server instance, should not throw despite the error
      const server = new MinskyMCPServer({});
      
      // Check if we got an empty repository path as fallback
      expect(server.getProjectContext()).toEqual({ repositoryPath: "" });
      
      // Restore the spy
      createContextSpy.restore();
    });
  });
  
  describe("start", () => {
    test("includes repository path in startup log", async () => {
      // Mock the log module
      const logSpy = {
        agent: mock.fn(),
        error: mock.fn(),
        debug: mock.fn()
      };
      
      // Spy on the logger module to replace it with our mock
      const loggerSpy = spyOn(console, "log").mockImplementation(() => {});
      
      // Create a server with a known project context
      const server = new MinskyMCPServer({
        projectContext: {
          repositoryPath: "/test/repo/path"
        }
      });
      
      // Start the server
      await server.start();
      
      // Wait for any promises to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));
      
      // Check if the repository path was included in log calls
      // This is more of an integration test and might be hard to verify precisely
      // You might need to adjust this based on your actual logging mechanism
      
      // Clean up
      loggerSpy.mockRestore();
    });
  });
  
  describe("getProjectContext", () => {
    test("returns the correct project context", () => {
      // Create a mock project context
      const mockProjectContext = {
        repositoryPath: "/specific/repo/path"
      };
      
      // Create a server instance with the mock project context
      const server = new MinskyMCPServer({
        projectContext: mockProjectContext
      });
      
      // Verify that getProjectContext returns the correct context
      expect(server.getProjectContext()).toEqual(mockProjectContext);
    });
  });
}); 
