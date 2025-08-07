#!/usr/bin/env bun
/**
 * Quick test to validate configuration loading for integration tests
 */

import { 
  CustomConfigFactory,
  initializeConfiguration,
  getConfiguration 
} from "./src/domain/configuration";

async function testConfiguration() {
  console.log("🔧 Testing configuration loading...");
  
  try {
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });
    
    const config = getConfiguration();
    console.log("✅ Configuration loaded successfully");
    
    // Check AI providers
    const aiConfig = config.ai;
    if (!aiConfig) {
      console.log("❌ No AI configuration found");
      return;
    }
    
    console.log(`📋 Found ${Object.keys(aiConfig.providers || {}).length} AI providers configured`);
    
    // Check Morph specifically
    const morphConfig = aiConfig.providers?.morph;
    if (!morphConfig) {
      console.log("❌ Morph provider not found in configuration");
      console.log("   Available providers:", Object.keys(aiConfig.providers || {}));
      return;
    }
    
    console.log("✅ Morph provider configuration found:");
    console.log(`   Enabled: ${morphConfig.enabled}`);
    console.log(`   Has API Key: ${!!morphConfig.apiKey}`);
    console.log(`   API Key Length: ${morphConfig.apiKey?.length || 0}`);
    console.log(`   Base URL: ${morphConfig.baseURL}`);
    console.log(`   Default Model: ${morphConfig.defaultModel}`);
    
    const hasValidMorphConfig = !!(
      morphConfig.enabled && 
      morphConfig.apiKey && 
      morphConfig.baseURL
    );
    
    if (hasValidMorphConfig) {
      console.log("🎉 Morph configuration is valid - integration tests can run!");
    } else {
      console.log("⚠️  Morph configuration incomplete - integration tests will be skipped");
      console.log("   Required: enabled = true, apiKey = 'your-key', baseURL = 'https://api.morph.so'");
    }
    
  } catch (error) {
    console.error("❌ Configuration test failed:", error);
  }
}

// Run the test
await testConfiguration();