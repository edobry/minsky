#!/usr/bin/env bun
/**
 * Debug Configuration Loading
 * 
 * Investigation: Why didn't session.edit_file pick up global Morph config?
 */

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration } from "./src/domain/configuration";

async function debugConfigLoading() {
  console.log("🔍 **Debugging Configuration Loading**\n");
  
  try {
    console.log("📋 **Step 1: Load Configuration**");
    await setupConfiguration();
    const config = getConfiguration();
    
    console.log("✅ Configuration loaded successfully");
    
    console.log("\n📋 **Step 2: Check AI Providers**");
    console.log("AI config exists:", !!config.ai);
    console.log("AI providers exist:", !!config.ai?.providers);
    
    if (config.ai?.providers) {
      console.log("\n🔧 **Available Providers:**");
      for (const [name, providerConfig] of Object.entries(config.ai.providers)) {
        console.log(`  ${name}:`);
        console.log(`    enabled: ${(providerConfig as any)?.enabled}`);
        console.log(`    hasApiKey: ${!!(providerConfig as any)?.apiKey}`);
        console.log(`    apiKey: ${(providerConfig as any)?.apiKey ? `${(providerConfig as any).apiKey.substring(0, 8)}...` : 'none'}`);
      }
    }
    
    console.log("\n📋 **Step 3: Check Morph Specifically**");
    const morphConfig = config.ai?.providers?.morph;
    console.log("Morph config exists:", !!morphConfig);
    console.log("Morph enabled:", morphConfig?.enabled);
    console.log("Morph API key:", morphConfig?.apiKey ? `${morphConfig.apiKey.substring(0, 8)}...` : 'missing');
    
    console.log("\n📋 **Step 4: Test Fast-Apply Provider Detection**");
    
    // This is the same logic our session.edit_file uses
    const fastApplyProviders = Object.entries(config.ai?.providers || {})
      .filter(([name, providerConfig]) =>
        (providerConfig as any)?.enabled && name === "morph"
      )
      .map(([name]) => name);
    
    console.log("Fast-apply providers found:", fastApplyProviders);
    
    if (fastApplyProviders.length === 0) {
      console.log("❌ **PROBLEM IDENTIFIED**");
      console.log("- Morph provider not detected as fast-apply capable");
      console.log("- This explains why session.edit_file fell back to legacy pattern matching");
    } else {
      console.log("✅ **Morph provider detected correctly**");
      
      console.log("\n📋 **Step 5: Test AI Completion Service Creation**");
      
      // Test if we can create the completion service
      const { DefaultAICompletionService } = await import("./src/domain/ai/completion-service");
      
      const mockConfigService = {
        loadConfiguration: () => Promise.resolve({ resolved: config }),
      };
      
      try {
        const completionService = new DefaultAICompletionService(mockConfigService);
        console.log("✅ AI Completion Service created successfully");
        
        // Test if we can get a Morph model
        console.log("\n📋 **Step 6: Test Morph Provider Access**");
        
        const testRequest = {
          prompt: "<instruction>test</instruction><code>test</code><update>test</update>",
          provider: "morph",
          model: "morph-v3-large",
          temperature: 0.1,
          maxTokens: 100
        };
        
        console.log("Testing completion request...");
        try {
          const result = await completionService.complete(testRequest);
          console.log("🎉 **SUCCESS: Morph API call worked!**");
          console.log("Response length:", result.content.length);
        } catch (apiError) {
          console.log("⚠️ **API Error (may be expected):**");
          console.log(apiError instanceof Error ? apiError.message : String(apiError));
        }
        
      } catch (serviceError) {
        console.log("❌ **Service Creation Error:**");
        console.log(serviceError instanceof Error ? serviceError.message : String(serviceError));
      }
    }
    
  } catch (error) {
    console.log(`\n❌ Error: ${error}`);
  }
}

if (import.meta.main) {
  debugConfigLoading();
} 
