#!/usr/bin/env bun
/**
 * Debug Configuration Loading
 *
 * This script helps debug the configuration loading process to understand
 * why Morph provider is not being recognized.
 */

import {
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration,
} from "../src/domain/configuration";

async function debugConfiguration(): Promise<void> {
  console.log("🔍 Debugging Configuration Loading\n");

  try {
    console.log("📁 Current working directory:", process.cwd());
    console.log("📁 __dirname equivalent:", import.meta.dir);

    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });

    const config = getConfiguration();
    console.log("\n📋 Loaded configuration:");
    console.log(JSON.stringify(config, null, 2));

    // Check specifically for AI configuration
    console.log("\n🤖 AI Configuration:");
    if (config.ai) {
      console.log("✅ AI config found");
      console.log("   Default provider:", config.ai.defaultProvider);
      console.log("   Providers configured:", Object.keys(config.ai.providers || {}));

      if (config.ai.providers?.morph) {
        console.log("✅ Morph provider found:");
        console.log("   Enabled:", config.ai.providers.morph.enabled);
        console.log("   Has API key:", !!config.ai.providers.morph.apiKey);
        console.log("   Model:", config.ai.providers.morph.model);
      } else {
        console.log("❌ Morph provider not found");
      }
    } else {
      console.log("❌ No AI configuration found");
    }
  } catch (error) {
    console.error("❌ Configuration loading failed:", error);
  }
}

if (import.meta.main) {
  await debugConfiguration();
}
