#!/usr/bin/env bun
/**
 * Test Morph Model Names
 *
 * Figure out what model names Morph actually accepts
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

async function testMorphModels() {
  console.log("🧪 **Testing Morph Model Names**\n");

  try {
    const morphProvider = createOpenAI({
      apiKey: "sk-S-E_EIrfm3MSanIWZDOVDOo-O8ABFsrzlgo1MtaXmLzYBRNz",
      baseURL: "https://api.morphllm.com/v1",
    });

    console.log("✅ Morph provider created");

    const modelsToTest = [
      "gpt-3.5-turbo",
      "gpt-4",
      "gpt-4o",
      "morph-v3-large", // This might work even though TypeScript complains
      "text-davinci-003",
      "gpt-4-turbo",
    ];

    for (const modelName of modelsToTest) {
      console.log(`\n📋 **Testing model: ${modelName}**`);

      try {
        // TypeScript will complain about custom model names, but let's see if it works at runtime
        const model = (morphProvider as any)(modelName);

        const response = await generateText({
          model,
          prompt: `Say exactly: 'Hello from ${modelName}!'`,
          temperature: 0.1,
          maxTokens: 30,
        });

        console.log(`🎉 **SUCCESS with ${modelName}!**`);
        console.log("Response:", response.text);
        console.log("Usage:", response.usage);
        break; // Exit on first success
      } catch (error) {
        console.log(
          `❌ ${modelName} failed:`,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof Error && error.message.includes("Not Found")) {
          console.log("   → Model not found on Morph API");
        } else if (error instanceof Error && error.message.includes("rate")) {
          console.log("   → Rate limit hit");
          break;
        } else if (error instanceof Error && error.message.includes("auth")) {
          console.log("   → Authentication issue");
          break;
        }
      }
    }

    console.log("\n📋 **Test Direct API Call**");

    // Let's also try a direct fetch to see what the API returns
    try {
      const response = await fetch("https://api.morphllm.com/v1/models", {
        headers: {
          Authorization: `Bearer sk-S-E_EIrfm3MSanIWZDOVDOo-O8ABFsrzlgo1MtaXmLzYBRNz`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        console.log("🎉 **Available models from Morph API:**");
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log("❌ Models API failed:", response.status, response.statusText);
        const errorText = await response.text();
        console.log("Error:", errorText);
      }
    } catch (fetchError) {
      console.log(
        "❌ Direct API call failed:",
        fetchError instanceof Error ? fetchError.message : String(fetchError)
      );
    }
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  }
}

if (import.meta.main) {
  testMorphModels();
}
