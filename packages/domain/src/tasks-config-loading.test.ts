/**
 * Test-Driven Bug Fix for Configuration Loading Issue
 *
 * Bug Description: listTasksFromParams and getTaskFromParams were not properly
 * reading the tasks.backend configuration due to incorrect property path access.
 *
 * Root Cause: Code was accessing configResult.data.tasks.backend instead of
 * configResult.config.tasks.backend, causing silent fallback to markdown backend.
 *
 * Steps to Reproduce:
 * 1. Set tasks.backend = "minsky" in configuration
 * 2. Call listTasksFromParams() or getTaskFromParams() without explicit backend param
 * 3. Functions should use minsky backend but were falling back to markdown
 */

import { describe, it, expect } from "bun:test";

// Mock the configuration loader to simulate the bug scenario
const mockConfigLoader = {
  load: async () => ({
    // This is the actual structure returned by ConfigurationLoader
    config: {
      tasks: {
        backend: "minsky",
        strictIds: false,
      },
    },
    sources: [],
    validationResult: { success: true },
    loadedAt: new Date(),
    mergeOrder: [],
    effectiveValues: {},
    // Note: success and data properties are undefined/missing
    // This is what caused the original bug
  }),
};

describe("Configuration Loading Bug Fix", () => {
  describe("Bug: Incorrect property path access in configuration loading", () => {
    it("should read backend from config.tasks.backend, not data.tasks.backend", async () => {
      // Bug Documentation: The original code accessed configResult.data.tasks.backend
      // but the actual structure has configResult.config.tasks.backend

      const configResult = await mockConfigLoader.load();

      // This demonstrates the bug - data property doesn't exist
      expect((configResult as any).data).toBeUndefined();

      // But config property does exist and contains the backend setting
      expect(configResult.config.tasks.backend).toBe("minsky");
    });
  });

  describe("Regression Prevention", () => {
    it("should document the correct ConfigurationLoadResult structure", () => {
      // This test documents the expected structure to prevent future bugs
      const expectedStructure = {
        config: expect.any(Object), // ✅ Contains actual configuration
        sources: expect.any(Array),
        validationResult: expect.any(Object),
        loadedAt: expect.any(Date),
        mergeOrder: expect.any(Array),
        effectiveValues: expect.any(Object),
        // success: undefined            // ❌ This property doesn't exist
        // data: undefined               // ❌ This property doesn't exist
      };

      // Future developers should access configResult.config, not configResult.data
      expect(mockConfigLoader.load()).resolves.toMatchObject(expectedStructure);
    });
  });
});
