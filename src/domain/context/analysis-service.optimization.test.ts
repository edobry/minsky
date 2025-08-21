import { describe, it, expect } from "bun:test";
import { ContextAnalysisService } from "./analysis-service";
import { ContextDiscoveryService } from "./discovery-service";
import { DefaultTokenizationService } from "../ai/tokenization/index";
import type { ContextElement } from "./types";

describe("ContextAnalysisService - Optimization Suggestions", () => {
  const mockDiscoveryService = {
    discoverContext: async () => [],
  } as any;

  const mockTokenizationService = {
    countTokens: async (content: string) => Math.floor(content.length / 4), // Simple approximation
  } as any;

  const analysisService = new ContextAnalysisService(mockDiscoveryService, mockTokenizationService);

  describe("optimization generation", () => {
    it("should suggest removing large test files with high confidence", async () => {
      const mockElements: ContextElement[] = [
        {
          id: "large-test",
          name: "src/components/Button.test.ts",
          type: "file",
          content: "x".repeat(8000), // 2000 tokens
          size: { bytes: 8000, characters: 8000 },
          path: "src/components/Button.test.ts",
          lastModified: new Date(),
        },
        {
          id: "small-file",
          name: "src/utils/helper.ts",
          type: "file",
          content: "x".repeat(400), // 100 tokens
          size: { bytes: 400, characters: 400 },
          path: "src/utils/helper.ts",
          lastModified: new Date(),
        },
      ];

      // Mock the discoverContext to return our test elements
      mockDiscoveryService.discoverContext = async () => mockElements;

      const result = await analysisService.analyzeContext({
        workspacePath: "/test",
        targetModel: "gpt-4o",
        options: { includeOptimizations: true },
      });

      expect(result.optimizations).toBeDefined();
      expect(result.optimizations!.length).toBeGreaterThan(0);

      // Should suggest removing test file
      const testFileOptimization = result.optimizations!.find(
        (opt) => opt.elementName === "src/components/Button.test.ts"
      );

      expect(testFileOptimization).toBeDefined();
      expect(testFileOptimization!.confidence).toBe("high");
      expect(testFileOptimization!.description).toInclude("Test file");
    });

    it("should suggest removing configuration files", async () => {
      const mockElements: ContextElement[] = [
        {
          id: "package-json",
          name: "package.json",
          type: "file",
          content: JSON.stringify({ dependencies: {} }).repeat(50), // ~1600 chars = 400 tokens
          size: { bytes: 1600, characters: 1600 },
          path: "package.json",
          lastModified: new Date(),
        },
      ];

      mockDiscoveryService.discoverContext = async () => mockElements;

      const result = await analysisService.analyzeContext({
        workspacePath: "/test",
        targetModel: "gpt-4o",
        options: { includeOptimizations: true },
      });

      const configOptimization = result.optimizations!.find(
        (opt) => opt.elementName === "package.json"
      );

      expect(configOptimization).toBeDefined();
      expect(configOptimization!.description).toInclude("Configuration file");
    });

    it("should suggest context restructuring for high utilization", async () => {
      // Create elements that total > 80% of 128k context window (> ~102k tokens)
      const largeContent = "x".repeat(420000); // ~105k tokens
      const mockElements: ContextElement[] = [
        {
          id: "massive-file",
          name: "src/large-file.ts",
          type: "file",
          content: largeContent,
          size: { bytes: 420000, characters: 420000 },
          path: "src/large-file.ts",
          lastModified: new Date(),
        },
      ];

      mockDiscoveryService.discoverContext = async () => mockElements;

      const result = await analysisService.analyzeContext({
        workspacePath: "/test",
        targetModel: "gpt-4o",
        options: { includeOptimizations: true },
      });

      const restructureOptimization = result.optimizations!.find(
        (opt) => opt.type === "restructure"
      );

      expect(restructureOptimization).toBeDefined();
      expect(restructureOptimization!.confidence).toBe("high");
      expect(restructureOptimization!.description).toInclude("High context utilization");
    });

    it("should prioritize optimizations by potential savings", async () => {
      const mockElements: ContextElement[] = [
        {
          id: "small-test",
          name: "small.test.ts",
          type: "file",
          content: "x".repeat(2000), // 500 tokens
          size: { bytes: 2000, characters: 2000 },
          path: "small.test.ts",
          lastModified: new Date(),
        },
        {
          id: "large-test",
          name: "large.test.ts",
          type: "file",
          content: "x".repeat(12000), // 3000 tokens
          size: { bytes: 12000, characters: 12000 },
          path: "large.test.ts",
          lastModified: new Date(),
        },
      ];

      mockDiscoveryService.discoverContext = async () => mockElements;

      const result = await analysisService.analyzeContext({
        workspacePath: "/test",
        targetModel: "gpt-4o",
        options: { includeOptimizations: true },
      });

      expect(result.optimizations!.length).toBeGreaterThan(0);

      // Should be sorted by potential savings (largest first)
      if (result.optimizations!.length > 1) {
        const first = result.optimizations![0];
        const second = result.optimizations![1];
        expect(first.potentialSavings).toBeGreaterThanOrEqual(second.potentialSavings);
      }
    });

    it("should handle empty context gracefully", async () => {
      mockDiscoveryService.discoverContext = async () => [];

      const result = await analysisService.analyzeContext({
        workspacePath: "/test",
        targetModel: "gpt-4o",
        options: { includeOptimizations: true },
      });

      expect(result.optimizations).toEqual([]);
      expect(result.summary.totalTokens).toBe(0);
    });
  });
});
