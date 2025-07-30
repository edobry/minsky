#!/usr/bin/env bun
/**
 * Test Apply Edit Pattern
 *
 * Debug why applyEditPattern is falling back to legacy instead of using fast-apply
 */

import { setupConfiguration } from "./src/config-setup";
import { getConfiguration } from "./src/domain/configuration";

async function testApplyEditPattern() {
  console.log("🧪 **Testing Apply Edit Pattern**\n");

  try {
    await setupConfiguration();
    const config = getConfiguration();

    console.log("📋 **Step 1: Check Fast-Apply Provider Detection**");

    // This is the same logic from session-edit-tools.ts
    const aiConfig = config.ai;

    if (!aiConfig?.providers) {
      console.log("❌ No AI providers configured");
      return;
    }

    console.log("✅ AI providers exist");

    // Find fast-apply capable provider
    const fastApplyProviders = Object.entries(aiConfig.providers)
      .filter(
        ([name, providerConfig]) =>
          providerConfig?.enabled &&
          // Check if provider supports fast-apply (morph for now, extendable)
          name === "morph"
      )
      .map(([name]) => name);

    console.log("Fast-apply providers found:", fastApplyProviders);

    if (fastApplyProviders.length === 0) {
      console.log("❌ No fast-apply providers detected - this explains the fallback");
      console.log("Checking morph specifically:");
      const morphConfig = aiConfig.providers.morph;
      console.log("- Morph exists:", !!morphConfig);
      console.log("- Morph enabled:", morphConfig?.enabled);
      console.log("- Name check (morph === 'morph'):", "morph" === "morph");
      return;
    }

    console.log("✅ Fast-apply providers detected:", fastApplyProviders);

    console.log("\n📋 **Step 2: Test AI Completion Service Creation**");

    const { DefaultAICompletionService } = await import("./src/domain/ai/completion-service");
    const { DefaultAIConfigurationService } = await import("./src/domain/ai/config-service");

    const configService = new DefaultAIConfigurationService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    } as any);
    const completionService = new DefaultAICompletionService({
      loadConfiguration: () => Promise.resolve({ resolved: config }),
    });

    console.log("✅ AI services created");

    console.log("\n📋 **Step 3: Test Fast-Apply Edit**");

    const originalContent = `function testMCPFixed() {
  console.log("original content");
  return true;
}`;

    const editContent = `function testMCPFixed() {
  // ... existing code ...
  console.log("UPDATED WITH XML FORMAT AND REAL API KEY!");
  // ... existing code ...
}`;

    const provider = fastApplyProviders[0];
    console.log(`Using fast-apply provider: ${provider}`);

    // Create fast-apply prompt (same as in session-edit-tools.ts)
    const prompt = `Apply the following edit pattern to the original content:

Original content:
\`\`\`
${originalContent}
\`\`\`

Edit pattern:
\`\`\`
${editContent}
\`\`\`

Instructions:
- Apply the edits shown in the edit pattern to the original content
- The edit pattern uses "// ... existing code ..." markers to indicate unchanged sections
- Return ONLY the complete updated file content
- Preserve all formatting, indentation, and structure
- Do not include explanations or markdown formatting`;

    try {
      const response = await completionService.complete({
        prompt,
        provider,
        model: provider === "morph" ? "morph-v3-large" : undefined,
        temperature: 0.1,
        maxTokens: Math.max(originalContent.length * 2, 4000),
        systemPrompt:
          "You are a precise code editor. Apply the edit pattern exactly as specified and return only the final updated content.",
      });

      console.log("🎉 **Fast-Apply Success!**");
      console.log("Result:");
      console.log("```");
      console.log(response.content.trim());
      console.log("```");

      console.log("\nUsage:", response.usage);

      if (response.content.includes("UPDATED WITH XML FORMAT")) {
        console.log("\n✅ **Perfect! Fast-apply edit worked correctly**");
      } else {
        console.log("\n⚠️ **Edit applied but content might need verification**");
      }
    } catch (error) {
      console.log("❌ Fast-apply failed:", error instanceof Error ? error.message : String(error));
      console.log("This explains why session.edit_file falls back to legacy");
    }
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  }
}

if (import.meta.main) {
  testApplyEditPattern();
}
