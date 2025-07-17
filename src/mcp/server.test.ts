/**
 * MCP Server Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";

describe("MCP Server", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("should import official MCP SDK module successfully", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    expect(Server).toBeDefined();
    expect(typeof Server).toBe("function");
  });

  test("should import stdio transport successfully", async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    expect(StdioServerTransport).toBeDefined();
    expect(typeof StdioServerTransport).toBe("function");
  });

  test("should be able to import our server modules", async () => {
    // Test that our server-related modules can be imported without errors
    let importSucceeded = false;
    try {
      const { MinskyMCPServer } = await import("./server");
      expect(MinskyMCPServer).toBeDefined();
      expect(typeof MinskyMCPServer).toBe("function");
      importSucceeded = true;
    } catch (error) {
      console.error("Import failed:", error);
      importSucceeded = false;
    }
    expect(importSucceeded).toBe(true);
  });

  test("should create MinskyMCPServer instance", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
    });

    expect(server).toBeDefined();
    expect(server.getProjectContext()).toBeDefined();
    expect(server.getTools()).toBeDefined();
    expect(server.getResources()).toBeDefined();
    expect(server.getPrompts()).toBeDefined();
  });
});
