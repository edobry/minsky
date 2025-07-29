#!/usr/bin/env bun
/**
 * Test-Driven Development Script for Morph Fast-Apply Integration
 *
 * This script validates the Morph API integration using real API calls.
 * Following TDD principles, we write tests first, then implement functionality.
 */

import { DefaultAICompletionService } from "../src/domain/ai/completion-service";
import { DefaultAIConfigurationService } from "../src/domain/ai/config-service";
import {
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration,
} from "../src/domain/configuration";
import { log } from "../src/utils/logger";

interface TestResult {
  name: string;
  success: boolean;
  duration: number;
  error?: string;
  details?: any;
}

class MorphIntegrationTester {
  private completionService: DefaultAICompletionService;
  private results: TestResult[] = [];

  constructor() {
    // This will be set up in runAllTests
    this.completionService = null as any;
  }

  async runAllTests(): Promise<void> {
    console.log("🚀 Starting Morph Fast-Apply Integration Tests\n");

    // Initialize configuration system
    console.log("🔧 Initializing configuration...");
    try {
      const factory = new CustomConfigFactory();
      await initializeConfiguration(factory, {
        workingDirectory: process.cwd(),
      });

      const config = getConfiguration();
      console.log(
        `   Found ${Object.keys(config.ai?.providers || {}).length} AI providers configured`
      );
      console.log(`   Morph enabled: ${config.ai?.providers?.morph?.enabled}`);

      // Create a mock config service that returns our loaded configuration
      const configService = new DefaultAIConfigurationService({
        loadConfiguration: (_workingDir: string) => Promise.resolve({ resolved: config }),
      } as any);

      this.completionService = new DefaultAICompletionService(configService);
      console.log("✅ Configuration initialized\n");
    } catch (error) {
      console.log(
        `❌ Configuration failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return;
    }

    // Test 1: Provider Configuration
    await this.testProviderConfiguration();

    // Test 2: Basic Model Creation
    await this.testModelCreation();

    // Test 3: Simple Completion
    await this.testSimpleCompletion();

    // Test 4: Fast-Apply Operation
    await this.testFastApplyOperation();

    // Test 5: Edit Pattern Application
    await this.testEditPatternApplication();

    // Test 6: Error Handling
    await this.testErrorHandling();

    // Print Results
    this.printResults();
  }

  private async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const startTime = Date.now();
    try {
      console.log(`📋 Running: ${name}...`);
      await testFn();
      const duration = Date.now() - startTime;
      this.results.push({ name, success: true, duration });
      console.log(`✅ PASS: ${name} (${duration}ms)\n`);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.results.push({ name, success: false, duration, error: errorMessage });
      console.log(`❌ FAIL: ${name} (${duration}ms)`);
      console.log(`   Error: ${errorMessage}\n`);
    }
  }

  private async testProviderConfiguration(): Promise<void> {
    await this.runTest("Provider Configuration", async () => {
      // Test that Morph provider can be configured
      const validation = await this.completionService.validateConfiguration();

      if (!validation.valid) {
        throw new Error(
          `Configuration validation failed: ${validation.errors.map((e) => e.message).join(", ")}`
        );
      }

      // Try to get available models for Morph
      const models = await this.completionService.getAvailableModels("morph");
      console.log(`   Found ${models.length} Morph models`);

      // Check if any model has fast-apply capability
      const fastApplyModels = models.filter((model) =>
        model.capabilities.some((cap) => cap.name === "fast-apply" && cap.supported)
      );

      if (fastApplyModels.length === 0) {
        console.log(`   Warning: No models with fast-apply capability found`);
      } else {
        console.log(`   Found ${fastApplyModels.length} fast-apply models`);
      }
    });
  }

  private async testModelCreation(): Promise<void> {
    await this.runTest("Model Creation", async () => {
      // Test creating a Morph model through the completion service
      try {
        const response = await this.completionService.complete({
          prompt: "Hello",
          provider: "morph",
          model: "morph-v3-large",
          maxTokens: 10,
        });

        if (!response.content) {
          throw new Error("No content returned from model");
        }

        console.log(`   Model response: "${response.content.slice(0, 50)}..."`);
        console.log(`   Tokens used: ${response.usage.totalTokens}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("API key")) {
          throw new Error("Morph API key not configured - set MORPH_API_KEY environment variable");
        }
        throw error;
      }
    });
  }

  private async testSimpleCompletion(): Promise<void> {
    await this.runTest("Simple Completion", async () => {
      const response = await this.completionService.complete({
        prompt: "Write a simple Hello World function in TypeScript",
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 200,
      });

      if (!response.content.includes("function") && !response.content.includes("Hello")) {
        throw new Error("Response doesn't appear to contain requested function");
      }

      console.log(`   Generated ${response.content.length} characters`);
      console.log(
        `   Token usage: ${response.usage.promptTokens} + ${response.usage.completionTokens} = ${response.usage.totalTokens}`
      );
    });
  }

  private async testFastApplyOperation(): Promise<void> {
    await this.runTest("Fast-Apply Operation", async () => {
      const originalCode = `function greet(name: string) {
  console.log("Hello, " + name);
}`;

      const editPattern = `function greet(name: string) {
  if (!name) {
    throw new Error("Name is required");
  }
  console.log("Hello, " + name);
}`;

      const prompt = `${originalCode}

UPDATE THE CODE:
${editPattern}`;

      const response = await this.completionService.complete({
        prompt,
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 300,
        systemPrompt:
          "You are a fast-apply model that merges code edits. Return only the updated code.",
      });

      if (!response.content.includes("Error") || !response.content.includes("required")) {
        throw new Error("Fast-apply operation didn't merge the edit correctly");
      }

      console.log(`   Successfully applied edit in ${response.usage.totalTokens} tokens`);
    });
  }

  private async testEditPatternApplication(): Promise<void> {
    await this.runTest("Edit Pattern Application", async () => {
      const originalCode = `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`;

      const editPattern = `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  
  subtract(a: number, b: number): number {
    return a - b;
  }
}`;

      const prompt = `Original code:
${originalCode}

Apply this edit pattern:
${editPattern}

Return only the updated code.`;

      const response = await this.completionService.complete({
        prompt,
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 400,
        temperature: 0.1, // Low temperature for precise code editing
      });

      if (!response.content.includes("subtract")) {
        throw new Error("Edit pattern didn't add the subtract method");
      }

      console.log(`   Successfully applied pattern with ${response.usage.totalTokens} tokens`);
    });
  }

  private async testErrorHandling(): Promise<void> {
    await this.runTest("Error Handling", async () => {
      try {
        // Test with invalid model
        await this.completionService.complete({
          prompt: "Test",
          provider: "morph",
          model: "invalid-model-name",
          maxTokens: 10,
        });

        throw new Error("Should have failed with invalid model");
      } catch (error) {
        if (error instanceof Error && error.message.includes("Should have failed")) {
          throw error;
        }
        // Expected error - this is good
        console.log(
          `   Correctly handled error: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Test provider fallback by trying a completion with unavailable provider
      try {
        await this.completionService.complete({
          prompt: "Test",
          provider: "nonexistent-provider" as any,
          maxTokens: 10,
        });

        throw new Error("Should have failed with nonexistent provider");
      } catch (error) {
        if (error instanceof Error && error.message.includes("Should have failed")) {
          throw error;
        }
        console.log(`   Correctly handled provider error`);
      }
    });
  }

  private printResults(): void {
    console.log("=".repeat(60));
    console.log("📊 TEST RESULTS SUMMARY");
    console.log("=".repeat(60));

    const passed = this.results.filter((r) => r.success).length;
    const failed = this.results.filter((r) => !r.success).length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);

    console.log(
      `\n📈 Overall: ${passed}/${this.results.length} tests passed (${((passed / this.results.length) * 100).toFixed(1)}%)`
    );
    console.log(`⏱️  Total time: ${totalDuration}ms\n`);

    if (failed > 0) {
      console.log("❌ FAILED TESTS:");
      this.results
        .filter((r) => !r.success)
        .forEach((result) => {
          console.log(`   • ${result.name}: ${result.error}`);
        });
      console.log();
    }

    if (passed === this.results.length) {
      console.log("🎉 All tests passed! Morph integration is working correctly.");
    } else {
      console.log(`⚠️  ${failed} test(s) failed. Check configuration and API connectivity.`);
    }

    console.log("\n💡 Next steps:");
    console.log("   1. Ensure MORPH_API_KEY is set in your configuration");
    console.log("   2. Update session edit tools to use fast-apply providers");
    console.log("   3. Implement session_reapply tool");
    console.log("   4. Add provider capability detection");
  }
}

// Run the tests if this script is executed directly
if (import.meta.main) {
  const tester = new MorphIntegrationTester();
  await tester.runAllTests();
}
