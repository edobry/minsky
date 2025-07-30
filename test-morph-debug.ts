#!/usr/bin/env bun
/**
 * Debug Morph Provider Configuration
 * 
 * Investigate exactly what configuration is being passed to the Morph provider
 */

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration } from "./src/domain/configuration";

async function debugMorphConfiguration() {
  console.log("🔍 **Debugging Morph Provider Configuration**\n");
  
  try {
    await setupConfiguration();
    const config = getConfiguration();
    
    console.log("📋 **Step 1: Raw Configuration**");
    console.log("Full AI config:", JSON.stringify(config.ai, null, 2));
    
    console.log("\n📋 **Step 2: Morph Provider Config**");
    const morphConfig = config.ai?.providers?.morph;
    console.log("Morph config:", JSON.stringify(morphConfig, null, 2));
    
    console.log("\n📋 **Step 3: AI Configuration Service**");
    const { DefaultAIConfigurationService } = await import("./src/domain/ai/config-service");
    
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);
    
    const providerConfig = await configService.getProviderConfig("morph");
    console.log("Provider config from service:", JSON.stringify(providerConfig, null, 2));
    
    console.log("\n📋 **Step 4: Language Model Creation Debug**");
    const { DefaultAICompletionService } = await import("./src/domain/ai/completion-service");
    
    const completionService = new DefaultAICompletionService({ 
      loadConfiguration: () => Promise.resolve({ resolved: config }) 
    });
    
    // Let's try to call the private method by accessing it directly
    // This is just for debugging
    try {
      console.log("Attempting to create language model for morph...");
      
      // We'll test by trying a simple completion and catching the detailed error
      const response = await completionService.complete({
        prompt: "Say hello",
        provider: "morph",
        model: "morph-v3-large",
        temperature: 0.1,
        maxTokens: 10
      });
      
      console.log("🎉 **SUCCESS**: Morph is working!");
      
    } catch (error) {
      console.log("\n❌ **Detailed Error Analysis**:");
      console.log("Error message:", error instanceof Error ? error.message : String(error));
      console.log("Error stack:", error instanceof Error ? error.stack : 'No stack');
      
      // Check if it's an authentication issue
      if (error instanceof Error && error.message.includes("OpenAI API key")) {
        console.log("\n🔧 **API Key Issue Detected**");
        console.log("This suggests the API key isn't reaching the OpenAI SDK properly");
        console.log("Expected apiKey:", providerConfig?.apiKey ? `${providerConfig.apiKey.substring(0, 8)}...` : 'missing');
      }
    }
    
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  }
}

if (import.meta.main) {
  debugMorphConfiguration();
} 
