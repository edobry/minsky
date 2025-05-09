import { describe, test, expect } from "bun:test";
import { CommandMapper } from "./command-mapper.js";
import { z } from "zod";

describe("CommandMapper", () => {
  test("addCommand registers a tool with the server", () => {
    // Create a mock FastMCP server
    const mockServer = {
      addTool: (tool: any) => {
        // Store the tool for verification
        mockAddedTool = tool;
      }
    };
    
    let mockAddedTool: any = null;
    
    // Create a command mapper with the mock server
    const commandMapper = new CommandMapper(mockServer as any);
    
    // Add a command
    commandMapper.addCommand({
      name: "test-command",
      description: "Test command",
      parameters: z.object({
        testParam: z.string()
      }),
      execute: async () => "test result"
    });
    
    // Verify the tool was added
    expect(mockAddedTool).toBeDefined();
    expect(mockAddedTool.name).toBe("test-command");
    expect(mockAddedTool.description).toBe("Test command");
  });
}); 
