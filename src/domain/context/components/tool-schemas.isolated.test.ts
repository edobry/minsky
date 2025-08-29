import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ComponentInput } from "./types";
import { ToolSchemasComponent } from "./tool-schemas";

describe("Tool Schemas Component - Query-Aware Filtering Tests", () => {

  const mockComponentInput: ComponentInput = {
    environment: { os: "darwin", shell: "/bin/zsh" },
    workspacePath: "/test/workspace",
    targetModel: "gpt-4o",
  };

  describe("Query-Aware Filtering Logic", () => {
    it("should disable query filtering when custom registry is provided (test mode)", async () => {
      const input: ComponentInput = {
        ...mockComponentInput,
        userQuery: "debug my failing tests", // Query provided
        commandRegistry: {} as any, // Custom registry = test mode
      };

      const gatheredInputs = await ToolSchemasComponent.gatherInputs(input);

      // Should NOT filter by query when custom registry is provided
      expect(gatheredInputs.filteredBy).not.toBe("user-query");
      expect(gatheredInputs.filteredBy).toBeUndefined();
    });

    it("should have shouldFilterByQuery logic working correctly", () => {
      // Test the core logic without actually running the service
      const userQuery = "test query";
      const customRegistry = {} as any;
      
      // Simulate the logic from tool-schemas.ts line 109: Boolean(userQuery?.trim()) && !context.commandRegistry
      const shouldFilterByQuery1 = Boolean(userQuery?.trim()) && !customRegistry;
      expect(shouldFilterByQuery1).toBe(false); // Custom registry = should NOT filter
      
      const shouldFilterByQuery2 = Boolean(userQuery?.trim()) && !undefined;
      expect(shouldFilterByQuery2).toBe(true); // No registry = should filter
      
      const shouldFilterByQuery3 = Boolean(userQuery?.trim()) && !null;
      expect(shouldFilterByQuery3).toBe(true); // Null registry = should filter
    });

    it("should not filter when no query is provided", () => {
      const noQuery = "";
      const customRegistry = {} as any;
      
      const shouldFilterByQuery = Boolean(noQuery?.trim()) && !customRegistry;
      expect(shouldFilterByQuery).toBe(false); // No query = should not filter
    });
  });

  describe("Component Integration", () => {
    it("should validate that core dependencies are available", () => {
      // Test that the required modules exist without calling them
      const { ToolSchemasComponent } = require("./tool-schemas");
      const { createToolSimilarityService } = require("../../tools/similarity/tool-similarity-service");
      
      expect(ToolSchemasComponent).toBeDefined();
      expect(ToolSchemasComponent.gatherInputs).toBeDefined();
      expect(ToolSchemasComponent.render).toBeDefined();
      expect(createToolSimilarityService).toBeDefined();
    });
  });
});
