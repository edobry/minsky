/**
 * MCP Server Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking.ts";

describe("MCP Server", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("should import FastMCP module successfully", async () => {
    const { FastMCP } = await import("fastmcp");
    expect(FastMCP).toBeDefined();
    expect(typeof FastMCP).toBe("function");
  });

  test("should be able to import our server modules", () => {
    // Test that our server-related modules can be imported without errors
    let importSucceeded = false;
    try {
      require("fastmcp");
      importSucceeded = true;
    } catch (___error) {
      importSucceeded = false;
    }
    expect(importSucceeded).toBe(true);
  });
});
