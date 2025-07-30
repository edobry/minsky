#!/usr/bin/env bun
/**
 * Test Fallback Without Morph
 * 
 * Temporarily disable Morph to test true fallback to default provider
 */

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration } from "./src/domain/configuration";

async function testFallbackWithoutMorph() {
  console.log("🧪 **Testing True Fallback (Morph Disabled)**\n");
  
  try {
    await setupConfiguration();
    const config = getConfiguration();
    
    console.log("📋 **Step 1: Check Current Configuration**");
    console.log("Default provider:", config.ai?.defaultProvider);
    console.log("Morph enabled:", config.ai?.providers?.morph?.enabled);
    console.log("Anthropic enabled:", config.ai?.providers?.anthropic?.enabled);
    console.log("OpenAI enabled:", config.ai?.providers?.openai?.enabled);
    
    console.log("\n📋 **Step 2: Temporarily Disable Morph**");
    
    // Temporarily disable Morph for this test
    if (config.ai?.providers?.morph) {
      (config.ai.providers.morph as any).enabled = false;
      console.log("✅ Morph temporarily disabled");
    }
    
    console.log("\n📋 **Step 3: Test Edit Without Fast-Apply Provider**");
    
    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");
    
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => {
        tools.set(tool.name, tool);
      }
    };
    
    registerSessionEditTools(mockCommandMapper as any);
    
    const sessionEditTool = tools.get("session.edit_file");
    
    // Create test file
    const fs = await import("fs/promises");
    await fs.writeFile("no-morph-test.ts", `interface UserData {
  id: string;
  name: string;
}

function processUser(user: UserData) {
  return user.name;
}`);
    
    console.log("✅ Test file created");
    
    // Test edit that should work with fallback provider
    const editPattern = `interface UserData {
  id: string;
  name: string;
  // ... existing code ...
  email?: string;
  // ... existing code ...
}

function processUser(user: UserData) {
  // ... existing code ...
  return {
    id: user.id,
    displayName: user.name,
    hasEmail: !!user.email
  };
  // ... existing code ...
}`;

    console.log("Testing edit with fallback provider...");
    
    const result = await sessionEditTool.handler({
      sessionName: "task249",
      path: "no-morph-test.ts", 
      content: editPattern,
      createDirs: false
    });
    
    if (result.success) {
      console.log("🎉 **SUCCESS with fallback provider!**");
      
      const content = await fs.readFile("no-morph-test.ts", "utf-8");
      console.log("\n📝 **Fallback Edit Result:**");
      console.log("```typescript");
      console.log(content);
      console.log("```");
      
      // Check if key changes were applied
      const hasEmail = content.includes("email?: string");
      const hasEnhancedReturn = content.includes("displayName");
      const hasEmailCheck = content.includes("hasEmail");
      
      console.log("\n🔍 **Edit Quality Assessment:**");
      console.log("• Added email field:", hasEmail ? "✅" : "❌");
      console.log("• Enhanced return object:", hasEnhancedReturn ? "✅" : "❌");
      console.log("• Email validation logic:", hasEmailCheck ? "✅" : "❌");
      
      if (hasEmail && hasEnhancedReturn && hasEmailCheck) {
        console.log("\n🏆 **Fallback Provider Performance: EXCELLENT**");
        console.log("• Fallback to default provider working ✅");
        console.log("• Edit quality maintained ✅");
        console.log("• No dependency on fast-apply providers ✅");
        console.log("• Graceful degradation successful ✅");
      } else {
        console.log("\n⚠️ **Fallback working but may need quality improvements**");
      }
      
    } else {
      console.log("❌ Fallback edit failed:", result.error);
      console.log("This indicates an issue with the fallback mechanism");
    }
    
    console.log("\n📋 **Step 4: Re-enable Morph**");
    if (config.ai?.providers?.morph) {
      (config.ai.providers.morph as any).enabled = true;
      console.log("✅ Morph re-enabled");
    }
    
  } catch (error) {
    console.log(`\n❌ Error: ${error}`);
  }
}

if (import.meta.main) {
  testFallbackWithoutMorph();
} 
