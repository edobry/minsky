/**
 * Comprehensive integration tests for session.edit_file MCP tool
 *
 * These tests verify that session.edit_file works with real Morph API calls
 * and covers diverse TypeScript editing scenarios with expected outcomes.
 *
 * Tests are specifically invoked (not run on every test suite execution).
 *
 * Usage: bun test tests/integration/session-edit-file-simplified.integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { applyEditPattern } from "../../src/adapters/mcp/session-edit-tools";
import {
  initializeConfiguration,
  CustomConfigFactory,
  getConfiguration,
} from "../../src/domain/configuration/index.js";

interface TestConfig {
  hasValidMorphConfig: boolean;
  morphBaseUrl?: string;
  morphApiKey?: string;
}

import {
  loadFixture,
  validateEditResult,
  coreTestCases,
  phase1TestCases,
  phase2TestCases,
  phase3TestCases,
  type EditTestCase,
} from "./helpers/edit-test-helpers";

// Test configuration
let testConfig: TestConfig;

beforeAll(async () => {
  try {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, { workingDirectory: process.cwd() });

    const config = getConfiguration();
    const morph = config.ai?.providers?.morph as any;

    const baseUrl = morph?.baseURL || morph?.baseUrl;
    const apiKey = morph?.apiKey;

    testConfig = {
      hasValidMorphConfig: Boolean(morph?.enabled && baseUrl && apiKey),
      morphBaseUrl: baseUrl,
      morphApiKey: apiKey,
    };

    if (!testConfig.hasValidMorphConfig) {
      console.log("⚠️  Morph not configured - integration tests will be skipped");
    } else {
      console.log(`✅ Morph configured via config system: ${baseUrl}`);
    }
  } catch (error) {
    console.error("Failed to initialize configuration:", error);
    testConfig = { hasValidMorphConfig: false };
  }
});

// cases imported from helpers

describe("Session Edit File Integration Tests", () => {
  describe("Core Edit Patterns", () => {
    coreTestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 1: Core TypeScript Patterns", () => {
    phase1TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 1 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ Phase 1 ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty edit pattern gracefully", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      const originalContent = await loadFixture("typescript/simple-class.ts");

      const result = await applyEditPattern(originalContent, "", "Add nothing");
      expect(result).toBeString();
      // With an empty edit pattern, the safest behavior is to return original content unchanged
      expect(result).toContain(originalContent.split("\n")[0]);
    });

    test("should handle malformed TypeScript gracefully", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping - Morph not configured");
        return;
      }

      const malformedContent = "export class {";

      const result = await applyEditPattern(
        malformedContent,
        "export class Fixed { }",
        "Fix the malformed class"
      );

      expect(result).toContain("Fixed");
    });
  });

  describe("Phase 2: Structural Complexity", () => {
    phase2TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 2 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ Phase 2 ${testCase.name} completed successfully`);
      });
    });
  });

  describe("Phase 3: Advanced Patterns", () => {
    phase3TestCases.forEach((testCase) => {
      test(`should handle ${testCase.name}`, async () => {
        if (!testConfig.hasValidMorphConfig) {
          console.log("⏭️  Skipping - Morph not configured");
          return;
        }

        console.log(`\n🧪 Phase 3 Testing: ${testCase.name}`);

        const originalContent = await loadFixture(testCase.fixture);
        console.log(`📄 Loaded fixture: ${testCase.fixture} (${originalContent.length} chars)`);

        const result = await applyEditPattern(
          originalContent,
          testCase.editPattern,
          testCase.instruction
        );

        validateEditResult(result, originalContent, testCase.editPattern, testCase.expected);

        console.log(`✅ Phase 3 ${testCase.name} completed successfully`);
      });
    });
  });
});

// Summary test for reporting
describe("Integration Test Summary", () => {
  test("should report test coverage summary", () => {
    const totalCases = coreTestCases.length + phase1TestCases.length + 2; // +2 for edge cases

    console.log(`\n📊 Integration Test Summary:`);
    console.log(`   Total test cases: ${totalCases}`);
    console.log(`   Core patterns: ${coreTestCases.length}`);
    console.log(`   Phase 1 patterns: ${phase1TestCases.length}`);
    console.log(`   Edge cases: 2`);
    console.log(`   Configuration: ${testConfig.hasValidMorphConfig ? "✅ Valid" : "❌ Invalid"}`);

    expect(totalCases).toBeGreaterThan(0);
  });
});
