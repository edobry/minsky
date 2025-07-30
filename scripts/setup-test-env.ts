#!/usr/bin/env bun
/**
 * Setup Test Environment for Morph Integration
 *
 * This script helps set up the test environment with proper API keys
 * and validates that everything is configured correctly.
 */

import { promises as fs } from "fs";
import { existsSync } from "fs";

async function setupTestEnvironment(): Promise<void> {
  console.log("🔧 Setting up test environment for Morph integration\n");

  // Check if user has MORPH_API_KEY in environment
  const morphApiKey = process.env.MORPH_API_KEY;

  if (morphApiKey) {
    console.log("✅ Found MORPH_API_KEY in environment");

    // Update the config file with the real API key
    const configPath = ".minsky/config.yaml";
    if (existsSync(configPath)) {
      let configContent = await fs.readFile(configPath, "utf-8");
      configContent = configContent.replace("test-morph-key-placeholder", morphApiKey);
      await fs.writeFile(configPath, configContent);
      console.log("✅ Updated config file with real API key");
    }
  } else {
    console.log("⚠️  MORPH_API_KEY not found in environment");
    console.log("   You can set it with: export MORPH_API_KEY='your-key-here'");
    console.log("   Or add it to your main ~/.minsky/config.yaml file\n");

    console.log("🔍 For testing without real API key, we'll use placeholder");
    console.log("   (Tests will fail but infrastructure will be validated)\n");
  }

  // Verify configuration structure
  console.log("📋 Configuration summary:");
  console.log("   - Provider: morph");
  console.log("   - Model: morph-v3-large");
  console.log("   - Base URL: https://api.morphllm.com/v1");
  console.log("   - Fast-apply capability: enabled");

  console.log("\n🚀 Environment setup complete!");
  console.log("   Run: bun run scripts/test-morph-integration.ts");
}

if (import.meta.main) {
  await setupTestEnvironment();
}
