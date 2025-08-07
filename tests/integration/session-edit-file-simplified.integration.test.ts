import { describe, test, expect, beforeAll } from "bun:test";

// Configuration system imports
import {
  initializeConfiguration,
  CustomConfigFactory,
} from "../../src/domain/configuration/index.js";

// Test helpers
import {
  getTestConfig,
  loadFixture,
  applyEditPattern,
  validateEditResult,
  commonTestCases,
  phase1TestCases,
  phase2TestCases,
  phase3TestCases,
  type EditTestCase,
} from "./helpers/edit-test-helpers.js";

// Global test configuration
let testConfig: Awaited<ReturnType<typeof getTestConfig>>;

describe("session.edit_file Simplified Integration", () => {
  beforeAll(async () => {
    console.log("🔧 Initializing configuration system...");

    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    testConfig = await getTestConfig();

    if (testConfig.hasValidMorphConfig) {
      console.log(`✅ Morph configured: ${testConfig.provider}/${testConfig.model}`);
    } else {
      console.log("⚠️  Morph not configured - tests will be skipped");
    }
  });

  describe("Configuration", () => {
    test("should have valid Morph configuration", () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      expect(testConfig.hasValidMorphConfig).toBe(true);
      expect(testConfig.baseURL).toBeDefined();
    });
  });

  describe("Core Edit Patterns", () => {
    // Run all common test cases
    commonTestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        // Load fixture
        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        // Apply edit pattern
        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          true // verbose
        );

        // Validate result
        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 1: Core TypeScript Patterns", () => {
    // Run all Phase 1 test cases
    phase1TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 1 Testing: ${testCase.name}`);

        // Load fixture
        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        // Apply edit pattern
        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          true // verbose
        );

        // Validate result
        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ Phase 1 ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 2: Structural Complexity", () => {
    // Run all Phase 2 test cases
    phase2TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 2 Testing: ${testCase.name}`);

        // Load fixture
        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        // Apply edit pattern
        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          true // verbose
        );

        // Validate result
        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ Phase 2 ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 3: Advanced Patterns", () => {
    // Run all Phase 3 test cases
    phase3TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 3 Testing: ${testCase.name}`);
        
        // Load fixture
        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);
        
        // Apply edit pattern
        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction,
          true // verbose
        );
        
        // Validate result
        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);
        
        console.log(`✅ Phase 3 ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty class", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      const originalContent = "export class EmptyCalculator {\n}";
      const editPattern = `export class EmptyCalculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`;

      const result = await applyEditPattern(
        originalContent,
        editPattern,
        "Add an add method to the empty class"
      );

      expect(result).toContain("add(a: number, b: number): number");
      expect(result).toContain("return a + b");
    });

    test("should handle malformed edit pattern gracefully", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      const originalContent = await loadFixture("typescript/simple-class.ts");
      const malformedPattern = `// Missing closing brace
  multiply(a: number, b: number): number {
    return a * b;
  // No closing brace for class`;

      // Should not throw, but may produce a warning
      const result = await applyEditPattern(
        originalContent,
        malformedPattern,
        "Add multiply method with malformed pattern"
      );

      // Result should still be valid even if pattern was malformed
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("Pattern Validation", () => {
    test("should work with minimal patterns", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      const originalContent = await loadFixture("typescript/simple-class.ts");

      // Minimal pattern following MorphLLM best practices
      const minimalPattern = `// ... existing code ...
  
  divide(a: number, b: number): number {
    return a / b;
  }
}`;

      const result = await applyEditPattern(
        originalContent,
        minimalPattern,
        "Add divide method using minimal pattern"
      );

      validateEditResult(result, originalContent, minimalPattern, {
        containsOriginal: true,
        containsNew: ["divide(a: number, b: number): number", "return a / b"],
        shouldGrow: true,
        noMarkers: true,
      });
    });
  });
});
