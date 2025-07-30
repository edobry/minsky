#!/usr/bin/env bun
/**
 * Working Morph Test - Using Production Pattern
 *
 * This script uses the exact same pattern as the production AI commands
 * to test Morph integration.
 */

import { DefaultAICompletionService } from "../src/domain/ai/completion-service";
import { DefaultAIConfigurationService } from "../src/domain/ai/config-service";
import {
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration,
} from "../src/domain/configuration";

async function testMorphWorking(): Promise<void> {
  console.log("🚀 Testing Morph with Production Pattern\n");

  try {
    // Initialize configuration exactly like production
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    // Get AI configuration exactly like production
    const config = getConfiguration();
    const aiConfig = config.ai;

    if (!aiConfig?.providers) {
      console.log("❌ No AI providers configured.");
      return;
    }

    console.log("✅ AI providers found:", Object.keys(aiConfig.providers));
    console.log("   Morph configured:", !!aiConfig.providers.morph);
    console.log("   Morph enabled:", aiConfig.providers.morph?.enabled);
    console.log("   Morph has API key:", !!aiConfig.providers.morph?.apiKey);

    // Create config service exactly like production
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);

    // Test getting morph config directly
    console.log("\n🔍 Testing getProviderConfig directly...");
    const morphProviderConfig = await configService.getProviderConfig("morph");

    if (morphProviderConfig) {
      console.log("✅ Morph provider config found:");
      console.log("   API Key:", `${morphProviderConfig.apiKey?.slice(0, 20)}...`);
      console.log("   Base URL:", morphProviderConfig.baseURL);
      console.log("   Model:", morphProviderConfig.defaultModel);
    } else {
      console.log("❌ Morph provider config not found");
      return;
    }

    // Create completion service
    const completionService = new DefaultAICompletionService(configService);
    console.log("✅ Completion service created");

    // Test a real API call
    console.log("\n🚀 Testing real Morph API call...");
    try {
      const response = await completionService.complete({
        prompt: "Hello! Please respond with exactly: 'Morph API is working correctly!'",
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 50,
        temperature: 0.1,
      });

      console.log("🎉 SUCCESS! Morph API call worked!");
      console.log("   Response:", response.content);
      console.log("   Model used:", response.model);
      console.log("   Provider:", response.provider);
      console.log(
        "   Tokens:",
        `${response.usage.promptTokens} + ${response.usage.completionTokens} = ${response.usage.totalTokens}`
      );

      // Test fast-apply capability
      console.log("\n🔧 Testing fast-apply capability...");
      const editResponse = await completionService.complete({
        prompt: `Original code:
function greet(name) {
  console.log("Hello, " + name);
}

Apply this edit:
function greet(name) {
  if (!name) throw new Error("Name required");
  console.log("Hello, " + name);
}

Return ONLY the final code.`,
        provider: "morph",
        model: "morph-v3-large",
        maxTokens: 200,
        temperature: 0.1,
        systemPrompt:
          "You are a fast code editor. Return only the final updated code without explanation.",
      });

      console.log("🎉 Fast-apply test successful!");
      console.log("   Edit result length:", editResponse.content.length);
      console.log("   Contains validation:", editResponse.content.includes("throw new Error"));
    } catch (error) {
      console.log("❌ API call failed:", error instanceof Error ? error.message : String(error));

      // Check if it's an authentication error
      if (error instanceof Error && error.message.includes("401")) {
        console.log("   This appears to be an authentication error");
        console.log("   Please check your MORPH_API_KEY");
      }
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

if (import.meta.main) {
  await testMorphWorking();
}
