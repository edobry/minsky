#!/usr/bin/env bun
/**
 * Test Morph Provider Integration
 * 
 * Verify that the Morph provider is properly integrated and can perform fast-apply edits
 */

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration } from "./src/domain/configuration";

async function testMorphIntegration() {
  console.log("🧪 **Testing Morph Provider Integration**\n");
  
  try {
    await setupConfiguration();
    const config = getConfiguration();
    
    console.log("📋 **Step 1: Verify Morph Configuration**");
    const morphConfig = config.ai?.providers?.morph;
    console.log("✅ Morph configured:", !!morphConfig);
    console.log("✅ Morph enabled:", morphConfig?.enabled);
    console.log("✅ Morph API key:", morphConfig?.apiKey ? `${morphConfig.apiKey.substring(0, 8)}...` : 'missing');
    
    console.log("\n📋 **Step 2: Test AI Completion Service**");
    const { DefaultAICompletionService } = await import("./src/domain/ai/completion-service");
    const { DefaultAIConfigurationService } = await import("./src/domain/ai/config-service");
    
    const configService = new DefaultAIConfigurationService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);
    
    const completionService = new DefaultAICompletionService({ loadConfiguration: () => Promise.resolve({ resolved: config }) });
    
    console.log("✅ AI Completion Service created");
    
    console.log("\n📋 **Step 3: Test Simple Completion**");
    
    // Simple test prompt
    const response = await completionService.complete({
      prompt: "Return exactly: 'Hello from Morph!'",
      provider: "morph",
      model: "morph-v3-large",
      temperature: 0.1,
      maxTokens: 50
    });
    
    console.log("🎉 **Success! Morph API Response:**");
    console.log("Response:", response.content);
    console.log("Provider:", response.provider);
    console.log("Model:", response.model);
    console.log("Tokens used:", response.usage.totalTokens);
    
    console.log("\n📋 **Step 4: Test Fast-Apply Edit Pattern**");
    
    const originalCode = `function greet() {
  console.log("Hello, world!");
  return "greeting";
}`;

    const editPattern = `function greet() {
  // ... existing code ...
  console.log("Hello from Morph fast-apply!");
  // ... existing code ...
}`;

    const editResponse = await completionService.complete({
      prompt: `Apply the following edit pattern to the original content:

Original content:
\`\`\`
${originalCode}
\`\`\`

Edit pattern:
\`\`\`
${editPattern}
\`\`\`

Instructions:
- Apply the edits shown in the edit pattern to the original content
- The edit pattern uses "// ... existing code ..." markers to indicate unchanged sections
- Return ONLY the complete updated file content
- Preserve all formatting, indentation, and structure
- Do not include explanations or markdown formatting`,
      provider: "morph",
      model: "morph-v3-large",
      temperature: 0.1,
      maxTokens: 200,
      systemPrompt: "You are a precise code editor. Apply the edit pattern exactly as specified and return only the final updated content."
    });
    
    console.log("\n🎉 **Fast-Apply Edit Result:**");
    console.log("Edited code:");
    console.log("```");
    console.log(editResponse.content);
    console.log("```");
    
    if (editResponse.content.includes("Hello from Morph fast-apply!")) {
      console.log("\n✅ **SUCCESS: Morph fast-apply integration working!**");
      console.log("- Morph provider ✅");
      console.log("- API authentication ✅");
      console.log("- Fast-apply edit processing ✅");
      console.log("- Pattern matching replacement ✅");
    } else {
      console.log("\n⚠️ **Partial Success**: Morph is working but edit pattern may need refinement");
    }
    
  } catch (error) {
    console.log("\n❌ **Error:**");
    console.log(error instanceof Error ? error.message : String(error));
    
    if (error instanceof Error) {
      if (error.message.includes("API key")) {
        console.log("\n🔧 **Fix**: Check Morph API key configuration");
      } else if (error.message.includes("not configured")) {
        console.log("\n🔧 **Fix**: Morph provider not properly configured");
      } else if (error.message.includes("rate limit")) {
        console.log("\n🔧 **Fix**: Morph API rate limit - try again later");
      } else {
        console.log("\n🔍 **Debug**: Unexpected error - check Morph API compatibility");
      }
    }
  }
}

if (import.meta.main) {
  testMorphIntegration();
} 
