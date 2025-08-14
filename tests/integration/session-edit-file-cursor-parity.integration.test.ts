import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
// Use mock.module() to mock filesystem operations
// import { readFile } from "fs/promises";
import { join } from "path";

// Configuration system imports
import {
  initializeConfiguration,
  getConfiguration,
  CustomConfigFactory,
} from "../../src/domain/configuration/index.js";

// Mock file system for testing
export const mockFiles = new Map<string, string>();

export function createMockFile(sessionName: string, path: string, content: string): void {
  const key = sessionName ? `${sessionName}/${path}` : path;
  mockFiles.set(key, content);
  console.log(`📄 Created mock file: ${key}`);
}

export function getMockFile(sessionName: string, path: string): string | undefined {
  const key = sessionName ? `${sessionName}/${path}` : path;
  return mockFiles.get(key);
}

export function resetMockFiles(): void {
  mockFiles.clear();
  console.log("🔄 Reset mock file system");
}

// Test configuration
let testConfig: {
  hasValidMorphConfig: boolean;
  baseURL: string;
};

async function loadFixture(name: string): Promise<string> {
  const fixturePath = join(process.cwd(), "tests", "fixtures", name);
  return await readFile(fixturePath, "utf-8");
}

// Enhanced applyEditPattern with comprehensive logging - recreated from session-edit-tools.ts
async function loggingApplyEditPattern(
  originalContent: string,
  editPattern: string
): Promise<string> {
  console.log(`\n${"=".repeat(80)}`);
  console.log("🔍 MORPH API REQUEST ANALYSIS");
  console.log("=".repeat(80));

  // Import utilities
  const { analyzeEditPattern, createMorphCompletionParams, MorphFastApplyRequest } = await import(
    "../../src/domain/ai/edit-pattern-utils.js"
  );

  console.log("\n📋 INPUT PARAMETERS:");
  console.log("📄 Original Content:");
  console.log("   Length:", originalContent.length, "characters");
  console.log("   Content:", JSON.stringify(originalContent, null, 2));

  console.log("\n📝 Edit Pattern:");
  console.log("   Length:", editPattern.length, "characters");
  console.log("   Content:", JSON.stringify(editPattern, null, 2));

  // Use utility for pattern analysis
  const patternAnalysis = analyzeEditPattern(editPattern);
  console.log("\n🔍 PATTERN ANALYSIS:");
  console.log("   Contains '// ... existing code ...' markers:", patternAnalysis.hasMarkers);
  console.log("   Number of marker sections:", patternAnalysis.markerCount);
  console.log("   Character count:", patternAnalysis.characterCount);
  console.log("   Line count:", patternAnalysis.lineCount);

  if (patternAnalysis.hasMarkers) {
    console.log("   Number of parts after splitting on markers:", patternAnalysis.parts.length);
    patternAnalysis.parts.forEach((part, index) => {
      console.log(`   Part ${index + 1}:`, JSON.stringify(part));
    });
  }

  // Validate pattern
  if (!patternAnalysis.validation.isValid) {
    console.log("\n⚠️  PATTERN VALIDATION ISSUES:");
    patternAnalysis.validation.issues.forEach((issue) => console.log("   -", issue));
    console.log("\n💡 SUGGESTIONS:");
    patternAnalysis.validation.suggestions.forEach((suggestion) => console.log("   -", suggestion));
  }

  console.log("\n🚀 CALLING MORPH API WITH REAL COMPLETION SERVICE...");
  const startTime = Date.now();

  try {
    // Use the same import pattern as session-edit-tools.ts
    const { DefaultAICompletionService } = await import(
      "../../src/domain/ai/completion-service.js"
    );
    const { getConfiguration } = await import("../../src/domain/configuration/index.js");

    const config = getConfiguration();
    console.log("\n📋 AI CONFIGURATION:");
    console.log("   Config loaded:", !!config);
    console.log("   AI providers:", Object.keys(config.ai?.providers || {}));

    const aiConfig = config.ai;
    if (!aiConfig?.providers) {
      throw new Error("No AI providers configured for edit operations");
    }

    // Find fast-apply capable provider (currently Morph, extendable to others)
    const fastApplyProviders = Object.entries(aiConfig.providers)
      .filter(
        ([name, providerConfig]) => providerConfig?.enabled && name === "morph" // Add other fast-apply providers here as needed
      )
      .map(([name]) => name);

    let provider: string;
    let model: string | undefined;

    if (fastApplyProviders.length > 0) {
      provider = fastApplyProviders[0]; // Use the first available fast-apply provider
      model = aiConfig.providers[provider]?.model;
      console.log(`   Using fast-apply provider: ${provider} with model: ${model}`);
    } else {
      // Fallback to any enabled provider
      const enabledProviders = Object.entries(aiConfig.providers)
        .filter(([, providerConfig]) => providerConfig?.enabled)
        .map(([name]) => name);

      if (enabledProviders.length === 0) {
        throw new Error("No enabled AI providers found for edit operations");
      }

      provider = enabledProviders[0];
      model = aiConfig.providers[provider]?.model;
      console.log(`   Using fallback provider: ${provider} with model: ${model}`);
    }

    // Create completion service with the same configuration pattern
    const completionService = new DefaultAICompletionService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);

    // Create the correct Morph Fast Apply API format using utilities
    const morphRequest: MorphFastApplyRequest = {
      instruction: "Add a multiply method to the Calculator class",
      originalCode: originalContent,
      editPattern: editPattern,
    };

    const completionParams = createMorphCompletionParams(morphRequest, {
      provider,
      model,
      temperature: 0.1,
      maxTokens: 4000,
    });

    const morphPrompt = completionParams.prompt;

    console.log("\n📤 CORRECT MORPH FAST APPLY API FORMAT:");
    console.log("   Prompt length:", morphPrompt.length, "characters");
    console.log("   Prompt content:", JSON.stringify(morphPrompt, null, 2));

    console.log("\n📋 COMPLETE REQUEST PARAMETERS:");
    console.log("   Full request object:", JSON.stringify(completionParams, null, 2));

    // Make the actual API call using the correct Morph Fast Apply format
    console.log("\n🌐 CALLING MORPH FAST APPLY API...");
    console.log("   Endpoint: POST https://api.morphllm.com/v1/chat/completions");
    console.log("   Provider:", provider);
    console.log("   Model:", model);

    // Intercept the actual HTTP request if possible
    const originalFetch = global.fetch;
    let capturedRequestBody: any = null;
    let capturedResponseBody: any = null;

    global.fetch = async (input: any, init: any) => {
      if (typeof input === "string" && input.includes("morphllm.com")) {
        console.log("\n🔍 INTERCEPTED HTTP REQUEST TO MORPH:");
        console.log("   URL:", input);
        console.log("   Method:", init?.method || "GET");
        console.log("   Headers:", JSON.stringify(init?.headers || {}, null, 2));

        if (init?.body) {
          try {
            capturedRequestBody = JSON.parse(init.body);
            console.log("   REQUEST BODY:", JSON.stringify(capturedRequestBody, null, 2));
          } catch (e) {
            console.log("   REQUEST BODY (raw):", init.body);
          }
        }
      }

      const response = await originalFetch(input, init);

      if (typeof input === "string" && input.includes("morphllm.com")) {
        const responseClone = response.clone();
        try {
          capturedResponseBody = await responseClone.json();
          console.log("\n📥 INTERCEPTED HTTP RESPONSE FROM MORPH:");
          console.log("   Status:", response.status, response.statusText);
          console.log("   Headers:", JSON.stringify([...response.headers.entries()], null, 2));
          console.log("   RESPONSE BODY:", JSON.stringify(capturedResponseBody, null, 2));
        } catch (e) {
          console.log("   Response body could not be parsed as JSON");
        }
      }

      return response;
    };

    const response = await completionService.complete(completionParams);

    // Restore original fetch
    global.fetch = originalFetch;

    const duration = Date.now() - startTime;
    const result = response.content.trim();

    console.log("\n✅ MORPH API RESPONSE:");
    console.log("   Duration:", duration, "ms");
    console.log("   Response type:", typeof response);
    console.log("   Response keys:", Object.keys(response));
    console.log("   Response content length:", result.length, "characters");
    console.log("   Response content:", JSON.stringify(result, null, 2));

    console.log("\n📊 RESULT ANALYSIS:");
    console.log("   Original length:", originalContent.length);
    console.log("   Edit pattern length:", editPattern.length);
    console.log("   Result length:", result.length);
    console.log(
      "   Result vs Original ratio:",
      `${(result.length / originalContent.length).toFixed(2)}x`
    );
    console.log(
      "   Result vs Pattern ratio:",
      `${(result.length / editPattern.length).toFixed(2)}x`
    );

    // Check if result contains both original and new content
    const originalLines = originalContent.split("\n").filter((line) => line.trim());
    const resultLines = result.split("\n");
    const containsOriginalContent = originalLines.some((line) =>
      resultLines.some((resultLine) => resultLine.includes(line.trim()))
    );
    console.log("   Contains original content lines:", containsOriginalContent);

    // Check for specific content
    console.log("\n🔍 DETAILED CONTENT ANALYSIS:");
    console.log("   Result contains 'add' method:", result.includes("add("));
    console.log("   Result contains 'multiply' method:", result.includes("multiply("));
    console.log(
      "   Result contains original class structure:",
      result.includes("export class Calculator")
    );

    console.log("\n🔍 DETAILED COMPARISON:");
    console.log(
      "   Expected behavior: Result should be longer than edit pattern if merging worked"
    );
    console.log(
      "   Actual behavior:",
      result.length > editPattern.length ? "✅ Longer (correct)" : "❌ Shorter/equal (incorrect)"
    );

    if (result.length <= editPattern.length) {
      console.log("   🚨 POTENTIAL BUG: Result is not longer than edit pattern!");
      console.log(
        "   This suggests the AI returned a cleaned edit pattern instead of merging with original content"
      );

      console.log("\n🔍 DEBUGGING ANALYSIS:");
      console.log(
        "   Does result match edit pattern exactly?",
        result.trim() === editPattern.replace(/\/\/ \.\.\. existing code \.\.\./g, "").trim()
      );
      console.log(
        "   Edit pattern without markers:",
        JSON.stringify(editPattern.replace(/\/\/ \.\.\. existing code \.\.\./g, ""))
      );
    }

    console.log("=".repeat(80));
    console.log("🔚 END MORPH API ANALYSIS");
    console.log(`${"=".repeat(80)}\n`);

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log("\n❌ MORPH API ERROR:");
    console.log("   Duration:", duration, "ms");
    console.log("   Error type:", error.constructor.name);
    console.log("   Error message:", error.message);
    console.log("   Error stack:", error.stack);
    console.log("=".repeat(80));
    console.log("🔚 END MORPH API ANALYSIS (ERROR)");
    console.log(`${"=".repeat(80)}\n`);
    throw error;
  }
}

describe("session.edit_file Cursor Parity Integration", () => {
  beforeAll(async () => {
    console.log("🔧 Initializing configuration system for integration tests...");

    // Initialize the configuration system
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    const config = getConfiguration();

    // Check Morph configuration
    const morphConfig = config.ai?.providers?.morph;

    // Apply default baseURL if not set (handling baseUrl vs baseURL inconsistency)
    const baseURL = morphConfig?.baseURL || morphConfig?.baseUrl || "https://api.morphllm.com/v1";

    const hasValidMorphConfig = !!(morphConfig?.enabled && morphConfig?.apiKey && baseURL);

    if (hasValidMorphConfig) {
      console.log("✅ Morph provider configured successfully");
      console.log("   API Key:", `${morphConfig.apiKey.substring(0, 20)}...`);
      console.log("   Base URL:", baseURL);
      console.log("   Model:", morphConfig.model);
    } else {
      console.log("⚠️  Morph configuration incomplete - integration tests will be skipped");
      console.log("   Enabled:", morphConfig?.enabled);
      console.log("   API Key:", morphConfig?.apiKey ? "present" : "missing");
      console.log("   Base URL (baseURL):", morphConfig?.baseURL ? "present" : "missing");
      console.log("   Base URL (baseUrl):", morphConfig?.baseUrl ? "present" : "missing");
      console.log("   Applied default baseURL:", baseURL);
    }

    testConfig = { hasValidMorphConfig, baseURL };
  });

  beforeEach(() => {
    resetMockFiles();
  });

  describe("Configuration Validation", () => {
    test("should have valid Morph configuration", () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping test - Morph provider not configured");
        return;
      }

      expect(testConfig.hasValidMorphConfig).toBe(true);
      expect(testConfig.baseURL).toBeDefined();
    });

    test("should create AI completion service successfully", () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping test - Morph provider not configured");
        return;
      }

      // This test just validates that we can get the configuration
      const config = getConfiguration();
      expect(config).toBeDefined();
      expect(config.ai?.providers?.morph).toBeDefined();
    });
  });

  describe("Core Edit Pattern Application", () => {
    test("should handle simple function addition with existing code markers", async () => {
      if (!testConfig.hasValidMorphConfig) {
        console.log("⏭️  Skipping test - Morph provider not configured");
        return;
      }

      // Load the original file content
      const originalContent = await loadFixture("typescript/simple-class.ts");
      console.log("📋 Original content:", JSON.stringify(originalContent));

      // This test validates the core edit pattern following MorphLLM best practices
      // Use minimal pattern - only show what's being added, not existing code
      const editPattern = `// ... existing code ...
  
  multiply(a: number, b: number): number {
    return a * b;
  }
}`;

      console.log("📝 Edit pattern (minimal):", JSON.stringify(editPattern));

      // Test the applyEditPattern function directly with comprehensive logging
      const result = await loggingApplyEditPattern(originalContent, editPattern);

      // Validate functional correctness of the edit
      expect(result).toBeDefined();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);

      // Verify the edit worked: both original and new methods should be present
      expect(result).toContain("add(a: number, b: number): number");
      expect(result).toContain("multiply(a: number, b: number): number");
      expect(result).toContain("return a + b"); // Original implementation
      expect(result).toContain("return a * b"); // New implementation

      // Verify class structure is preserved
      expect(result).toContain("export class Calculator");
      expect(result).toContain("class Calculator {");

      // Verify markers are properly processed (should be removed in final output)
      expect(result).not.toContain("// ... existing code ...");

      // Verify the result is longer than the original (original + new content)
      expect(result.length).toBeGreaterThan(originalContent.length);

      // Verify the result is well-formed TypeScript (basic syntax check)
      expect(result).toMatch(/export class Calculator \{[\s\S]*\}/);
      expect(result.split("{").length).toBe(result.split("}").length); // Balanced braces

      console.log(`✅ Edit pattern test completed successfully`);
    });
  });
});
