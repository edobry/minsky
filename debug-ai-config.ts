#!/usr/bin/env bun

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration, getConfigurationProvider } from "./src/domain/configuration";
import { DefaultAIConfigurationService } from "./src/domain/ai/config-service";

async function debugAIConfig() {
  console.log("=== AI Configuration Debug ===\n");

  // Initialize configuration first
  await setupConfiguration();

  // 1. Check what getConfiguration() returns
  console.log("1. Raw configuration:");
  const config = getConfiguration();
  console.log("config.ai:", JSON.stringify(config.ai, null, 2));

  // 2. Check configuration provider
  console.log("\n2. Configuration provider:");
  const provider = getConfigurationProvider();
  console.log("Provider type:", provider.constructor.name);
  console.log("Provider methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(provider)));
  console.log("Has loadConfiguration?", "loadConfiguration" in provider);

  // 3. Test AI configuration service with both approaches
  console.log("\n3. Testing AI configuration service:");

  // Approach 1: Mock like in suggest-rules.ts
  const mockConfigService = {
    loadConfiguration: () => Promise.resolve({ resolved: config }),
  };
  const aiConfigService1 = new DefaultAIConfigurationService(mockConfigService as any);

  console.log("\nApproach 1 (mock):");
  try {
    const openaiConfig1 = await aiConfigService1.getProviderConfig("openai");
    console.log("OpenAI config:", openaiConfig1);
  } catch (error) {
    console.error("Error:", error.message);
  }

  // Approach 2: Real configuration provider
  const aiConfigService2 = new DefaultAIConfigurationService(provider);

  console.log("\nApproach 2 (real provider):");
  try {
    const openaiConfig2 = await aiConfigService2.getProviderConfig("openai");
    console.log("OpenAI config:", openaiConfig2);
  } catch (error) {
    console.error("Error:", error.message);
  }

  // 4. Check all providers
  console.log("\n4. Testing all providers:");
  const providers = ["openai", "anthropic", "google", "morph"];

  for (const providerName of providers) {
    try {
      const providerConfig = await aiConfigService2.getProviderConfig(providerName);
      console.log(`${providerName}:`, providerConfig ? "✓ configured" : "✗ not found");
      if (providerConfig) {
        console.log(`  - API Key: ${providerConfig.apiKey ? "present" : "missing"}`);
        console.log(`  - Model: ${providerConfig.defaultModel}`);
      }
    } catch (error) {
      console.log(`${providerName}: ✗ error - ${error.message}`);
    }
  }
}

debugAIConfig().catch(console.error);
