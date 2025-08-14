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
// Use mock.module() to mock filesystem operations
// import { readFile } from "fs/promises";
import { join } from "path";
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

interface EditTestCase {
  name: string;
  fixture: string;
  instruction: string;
  editPattern: string;
  expected: {
    containsOriginal: boolean;
    containsNew: string[];
    shouldGrow: boolean;
    noMarkers: boolean;
  };
}

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

async function loadFixture(fixturePath: string): Promise<string> {
  const fullPath = join(process.cwd(), "tests/fixtures", fixturePath);
  return await readFile(fullPath, "utf-8");
}

function validateEditResult(
  result: string,
  originalContent: string,
  editPattern: string,
  expected: EditTestCase["expected"]
): void {
  // Validate result structure
  expect(result).toBeString();
  expect(result.length).toBeGreaterThan(0);

  // Check if original content should be preserved
  if (expected.containsOriginal) {
    expect(result).toContain(originalContent.split("\n")[0]); // At least first line should be preserved
  }

  // Check for new content
  for (const newContent of expected.containsNew) {
    expect(result).toContain(newContent);
  }

  // Check growth expectation
  if (expected.shouldGrow) {
    expect(result.length).toBeGreaterThanOrEqual(editPattern.length);
  }

  // Check marker removal
  if (expected.noMarkers) {
    expect(result).not.toContain("// ... existing code ...");
  }
}

// Core test cases
const coreTestCases: EditTestCase[] = [
  {
    name: "method addition to simple class",
    fixture: "typescript/simple-class.ts",
    instruction: "Add a multiply method to the Calculator class",
    editPattern: `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["multiply", "a * b"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

// Phase 1: Core TypeScript Patterns
const phase1TestCases: EditTestCase[] = [
  {
    name: "property/field addition to class",
    fixture: "typescript/class-with-properties.ts",
    instruction: "Add a cache property and maxRetries field to the UserService class",
    editPattern: `export class UserService {
  private users: User[] = [];
  private cache: Map<string, User> = new Map();
  private readonly maxRetries: number = 3;

  // ... existing code ...
}`,
    expected: {
      containsOriginal: true,
      containsNew: ["private cache: Map<string, User>", "maxRetries: number = 3"],
      shouldGrow: true,
      noMarkers: true,
    },
  },
];

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
