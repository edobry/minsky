#!/usr/bin/env bun
/**
 * Test Completion Service with Morph
 *
 * This script directly tests the completion service to isolate the issue.
 */

import { DefaultAICompletionService } from "../src/domain/ai/completion-service";
import { DefaultAIConfigurationService } from "../src/domain/ai/config-service";
import {
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration,
} from "../src/domain/configuration";

async function testCompletionService(): Promise<void> {
  console.log("🔍 Testing Completion Service with Morph\n");

  try {
    // Initialize configuration
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    const config = getConfiguration();
    console.log("✅ Configuration loaded");

    // Create services
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: (_workingDir: string) => Promise.resolve({ resolved: config }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- diagnostic script, not production code
    } as any);

    const completionService = new DefaultAICompletionService(configService);
    console.log("✅ Services created");

    // Test 1: Validate configuration
    console.log("\n📋 Testing validateConfiguration()...");
    const validation = await completionService.validateConfiguration();
    console.log("   Valid:", validation.valid);
    if (!validation.valid) {
      console.log(
        "   Errors:",
        validation.errors.map((e) => e.message)
      );
    }
    if (validation.warnings?.length) {
      console.log(
        "   Warnings:",
        validation.warnings.map((w) => w.message)
      );
    }

    // Test 2: Get available models for Morph
    console.log("\n📋 Testing getAvailableModels('morph')...");
    try {
      const models = await completionService.getAvailableModels("morph");
      console.log("✅ Found", models.length, "models for Morph");
      models.forEach((model) => {
        console.log(`   - ${model.id}: ${model.name}`);
        console.log(`     Capabilities: ${model.capabilities.map((c) => c.name).join(", ")}`);
      });
    } catch (error) {
      console.log(
        "❌ Failed to get models:",
        error instanceof Error ? error.message : String(error)
      );
    }

    // Test 3: Try a simple completion with explicit provider
    console.log("\n📋 Testing completion with Morph...");
    try {
      const response = await completionService.complete({
        prompt: "Say 'Hello from Morph!'",
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 20,
        temperature: 0.1,
      });

      console.log("✅ Completion successful!");
      console.log("   Content:", response.content);
      console.log("   Model:", response.model);
      console.log("   Provider:", response.provider);
      console.log("   Tokens used:", response.usage.totalTokens);
    } catch (error) {
      console.log("❌ Completion failed:", error instanceof Error ? error.message : String(error));
      console.log("   Error type:", error?.constructor?.name);
      if (error instanceof Error && "provider" in error) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- diagnostic script, not production code
        console.log("   Error provider:", (error as any).provider);
      }
    }

    // Test 4: Try with default provider (should use openai)
    console.log("\n📋 Testing completion with default provider...");
    try {
      const response = await completionService.complete({
        prompt: "Say 'Hello from default!'",
        maxTokens: 20,
        temperature: 0.1,
      });

      console.log("✅ Default completion successful!");
      console.log("   Provider used:", response.provider);
    } catch (error) {
      console.log(
        "❌ Default completion failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

if (import.meta.main) {
  await testCompletionService();
}
