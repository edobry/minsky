#!/usr/bin/env bun
/**
 * Debug AI Configuration Service
 *
 * This script debugs the AI configuration service to understand why
 * it's not recognizing the Morph provider.
 */

import {
  DefaultAIConfigurationService,
  type AnyConfigService,
} from "../src/domain/ai/config-service";
import {
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration,
} from "../src/domain/configuration";

async function debugAIConfig(): Promise<void> {
  console.log("🔍 Debugging AI Configuration Service\n");

  try {
    // Initialize configuration
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    const config = getConfiguration();
    console.log("📋 Full config loaded successfully");
    console.log("   AI providers:", Object.keys(config.ai?.providers || {}));

    // Create AI config service
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: (_workingDir: string) => Promise.resolve({ resolved: config }),
    } as AnyConfigService);

    // Test getProviderConfig for Morph
    console.log("\n🔍 Testing getProviderConfig('morph')...");
    const morphConfig = await configService.getProviderConfig("morph");

    if (morphConfig) {
      console.log("✅ Morph config found:");
      console.log("   Provider:", morphConfig.provider);
      console.log("   Has API key:", !!morphConfig.apiKey);
      console.log("   Base URL:", morphConfig.baseURL);
      console.log("   Default model:", morphConfig.defaultModel);
      console.log(
        "   Capabilities:",
        morphConfig.supportedCapabilities.map((c) => c.name)
      );
    } else {
      console.log("❌ Morph config not found");
    }

    // Test other providers for comparison
    console.log("\n🔍 Testing getProviderConfig('openai')...");
    const openaiConfig = await configService.getProviderConfig("openai");
    console.log(openaiConfig ? "✅ OpenAI found" : "❌ OpenAI not found");

    // Test default provider
    console.log("\n🔍 Testing getDefaultProvider()...");
    const defaultProvider = await configService.getDefaultProvider();
    console.log("   Default provider:", defaultProvider);

    // Test validateProviderKey
    console.log("\n🔍 Testing validateProviderKey for morph...");
    if (config.ai?.providers?.morph?.apiKey) {
      const isValid = await configService.validateProviderKey(
        "morph",
        config.ai.providers.morph.apiKey
      );
      console.log("   Morph API key validation:", isValid ? "✅ Valid" : "❌ Invalid");
    }
  } catch (error) {
    console.error("❌ Debug failed:", error);
  }
}

if (import.meta.main) {
  await debugAIConfig();
}
