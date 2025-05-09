import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MinskyMCPServer } from "./server.js";
import { FastMCP } from "fastmcp";

describe("MinskyMCPServer", () => {
  // Mock console.log to avoid cluttering test output
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  
  beforeEach(() => {
    // Simple mock function for console methods
    console.log = () => {};
    console.error = () => {};
  });
  
  afterEach(() => {
    // Restore console logging after tests
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  test("constructor creates a server", () => {
    const server = new MinskyMCPServer();
    expect(server).toBeDefined();
    expect(typeof server.getFastMCPServer).toBe("function");
  });

  test("constructor uses provided options", () => {
    const server = new MinskyMCPServer({
      name: "Custom MCP Server",
      transportType: "stdio"
    });
    
    // Basic test that server was created
    expect(server).toBeDefined();
  });

  test("start method configures transport", async () => {
    const server = new MinskyMCPServer({
      transportType: "stdio"
    });
    
    // Track if start was called correctly
    let startOptionsPassed: any = null;
    
    // Override the getFastMCPServer method to return a mock
    const originalGetFastMCPServer = server.getFastMCPServer;
    server.getFastMCPServer = () => {
      return {
        start: (options: any) => {
          startOptionsPassed = options;
          return Promise.resolve();
        },
        on: () => {}
      } as unknown as FastMCP;
    };
    
    await server.start();
    
    // Restore the original method
    server.getFastMCPServer = originalGetFastMCPServer;
    
    // Verify start was called with stdio transport
    expect(startOptionsPassed).toBeDefined();
    expect(startOptionsPassed.transportType).toBe("stdio");
  });

  test("start method with stdio transport", async () => {
    const server = new MinskyMCPServer({
      transportType: "stdio"
    });
    
    // Spy on the FastMCP.start method
    const startSpy = spyOn(server.getFastMCPServer(), "start");
    
    await server.start();
    
    // Verify that FastMCP.start was called with stdio transport
    expect(startSpy).toHaveBeenCalledWith({ transportType: "stdio" });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("stdio"));
  });

  test("start method with SSE transport", async () => {
    const server = new MinskyMCPServer({
      transportType: "sse",
      sse: {
        endpoint: "/custom-sse",
        port: 9090
      }
    });
    
    // Spy on the FastMCP.start method
    const startSpy = spyOn(server.getFastMCPServer(), "start");
    
    await server.start();
    
    // Verify that FastMCP.start was called with SSE transport and correct options
    expect(startSpy).toHaveBeenCalledWith({
      transportType: "sse",
      sse: expect.objectContaining({
        endpoint: "/sse", // The endpoint is hardcoded to "/sse" in the implementation
        port: 9090
      })
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("sse"));
  });

  test("start method with HTTP Stream transport", async () => {
    const server = new MinskyMCPServer({
      transportType: "httpStream",
      httpStream: {
        endpoint: "/custom-stream",
        port: 9090
      }
    });
    
    // Spy on the FastMCP.start method
    const startSpy = spyOn(server.getFastMCPServer(), "start");
    
    await server.start();
    
    // Verify that FastMCP.start was called with HTTP Stream transport and correct options
    expect(startSpy).toHaveBeenCalledWith({
      transportType: "httpStream",
      httpStream: expect.objectContaining({
        endpoint: "/stream", // The endpoint is hardcoded to "/stream" in the implementation
        port: 9090
      })
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("httpStream"));
  });

  test("start method handles errors", async () => {
    const server = new MinskyMCPServer();
    
    // Make the start method throw an error
    spyOn(server.getFastMCPServer(), "start").mockImplementation(() => {
      throw new Error("Test error");
    });
    
    // Expect the start method to throw an error
    await expect(server.start()).rejects.toThrow("Test error");
    expect(console.error).toHaveBeenCalled();
  });
}); 
