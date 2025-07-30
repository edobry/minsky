#!/usr/bin/env bun
/**
 * Test Fallback with Mocked AI Providers
 * 
 * Tests the edit_file fallback logic with mocked AI provider implementations
 */

import { test, expect, mock, beforeEach, describe } from "bun:test";

// Mock the AI completion service
const mockComplete = mock();
const mockDefaultAICompletionService = mock(() => ({
  complete: mockComplete
}));

// Mock the configuration
let mockConfig: any = {};
const mockGetConfiguration = mock(() => mockConfig);

// Mock imports
mock.module("../../domain/ai/completion-service", () => ({
  DefaultAICompletionService: mockDefaultAICompletionService
}));

mock.module("../../domain/configuration", () => ({
  getConfiguration: mockGetConfiguration
}));

describe("Session Edit Fallback Logic", () => {
  beforeEach(() => {
    // Reset mocks
    mockComplete.mockReset();
    mockDefaultAICompletionService.mockReset();
    mockGetConfiguration.mockReset();
    
    // Reset mock completion response
    mockComplete.mockResolvedValue({
      content: "mocked edit result",
      usage: { totalTokens: 100, promptTokens: 50, completionTokens: 50 }
    });
  });

  test("should use fast-apply provider (Morph) when available", async () => {
    // Arrange: Configure Morph as enabled
    mockConfig = {
      ai: {
        defaultProvider: "openai",
        providers: {
          morph: { enabled: true, apiKey: "mock-morph-key" },
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
          openai: { enabled: false }
        }
      }
    };

    // Import after mocking
    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => tools.set(tool.name, tool)
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    const sessionEditTool = tools.get("session.edit_file");

    // Act: Call edit with Morph available
    const result = await sessionEditTool.handler({
      sessionName: "test",
      path: "test.ts",
      content: "edit pattern"
    });

    // Assert: Should use Morph (fast-apply)
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "morph",
        model: "morph-v3-large"
      })
    );
    expect(result.success).toBe(true);
  });

  test("should fallback to default provider when no fast-apply available", async () => {
    // Arrange: No fast-apply providers, Anthropic as default
    mockConfig = {
      ai: {
        defaultProvider: "anthropic",
        providers: {
          morph: { enabled: false },
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
          openai: { enabled: true, apiKey: "mock-openai-key" }
        }
      }
    };

    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => tools.set(tool.name, tool)
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    const sessionEditTool = tools.get("session.edit_file");

    // Act: Call edit without fast-apply
    const result = await sessionEditTool.handler({
      sessionName: "test",
      path: "test.ts", 
      content: "edit pattern"
    });

    // Assert: Should use Anthropic (fallback)
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic"
      })
    );
    expect(result.success).toBe(true);
  });

  test("should use first available provider when default provider unavailable", async () => {
    // Arrange: Default provider disabled, OpenAI available
    mockConfig = {
      ai: {
        defaultProvider: "anthropic",
        providers: {
          morph: { enabled: false },
          anthropic: { enabled: false }, // Default disabled
          openai: { enabled: true, apiKey: "mock-openai-key" },
          google: { enabled: true, apiKey: "mock-google-key" }
        }
      }
    };

    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => tools.set(tool.name, tool)
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    const sessionEditTool = tools.get("session.edit_file");

    // Act: Call edit with default unavailable
    const result = await sessionEditTool.handler({
      sessionName: "test",
      path: "test.ts",
      content: "edit pattern"
    });

    // Assert: Should use first available provider (OpenAI)
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai"
      })
    );
    expect(result.success).toBe(true);
  });

  test("should skip providers without API keys", async () => {
    // Arrange: Some providers enabled but missing API keys
    mockConfig = {
      ai: {
        defaultProvider: "openai",
        providers: {
          morph: { enabled: false },
          openai: { enabled: true }, // No API key
          anthropic: { enabled: true, apiKey: "mock-anthropic-key" },
          google: { enabled: true } // No API key
        }
      }
    };

    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => tools.set(tool.name, tool)
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    const sessionEditTool = tools.get("session.edit_file");

    // Act: Call edit with mixed provider availability
    const result = await sessionEditTool.handler({
      sessionName: "test",
      path: "test.ts",
      content: "edit pattern"
    });

    // Assert: Should use Anthropic (has API key)
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic"
      })
    );
    expect(result.success).toBe(true);
  });

  test("should handle AI completion errors gracefully", async () => {
    // Arrange: Configure provider but mock error
    mockConfig = {
      ai: {
        defaultProvider: "anthropic",
        providers: {
          anthropic: { enabled: true, apiKey: "mock-key" }
        }
      }
    };

    mockComplete.mockRejectedValue(new Error("AI service unavailable"));

    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => tools.set(tool.name, tool)
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    const sessionEditTool = tools.get("session.edit_file");

    // Act: Call edit with AI error
    const result = await sessionEditTool.handler({
      sessionName: "test",
      path: "test.ts",
      content: "edit pattern"
    });

    // Assert: Should handle error gracefully
    expect(result.success).toBe(false);
    expect(result.error).toContain("AI service unavailable");
  });
});

console.log("🧪 **Running Fallback Logic Tests with Mocked Providers**"); 
