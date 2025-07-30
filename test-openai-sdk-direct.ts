#!/usr/bin/env bun
/**
 * Test OpenAI SDK Directly with Morph
 *
 * Test the @ai-sdk/openai package directly to see if the issue is with our usage
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

async function testOpenAISDKDirect() {
  console.log("🧪 **Testing OpenAI SDK Directly with Morph**\n");

  try {
    console.log("📋 **Step 1: Create Morph model using OpenAI SDK**");

    const morphApiKey = "sk-S-E_EIrfm3MSanIWZDOVDOo-O8ABFsrzlgo1MtaXmLzYBRNz";
    const morphBaseURL = "https://api.morphllm.com/v1";
    const morphModel = "morph-v3-large";

    console.log("Using:");
    console.log("- API Key:", `${morphApiKey.substring(0, 8)}...`);
    console.log("- Base URL:", morphBaseURL);
    console.log("- Model:", morphModel);

    // Test 1: Try the format we're currently using
    console.log("\n📋 **Test 1: Current format**");
    try {
      const model1 = openai(morphModel, {
        apiKey: morphApiKey,
        baseURL: morphBaseURL,
      });

      console.log("✅ Model created successfully");

      const response1 = await generateText({
        model: model1,
        prompt: "Say exactly: 'Hello from Morph via OpenAI SDK!'",
        temperature: 0.1,
        maxTokens: 50,
      });

      console.log("🎉 **SUCCESS!**");
      console.log("Response:", response1.text);
      console.log("Usage:", response1.usage);
    } catch (error) {
      console.log("❌ Test 1 failed:", error instanceof Error ? error.message : String(error));

      // Test 2: Try with different configuration
      console.log("\n📋 **Test 2: Alternative format**");
      try {
        const model2 = openai(morphModel, {
          apiKey: morphApiKey,
          baseURL: morphBaseURL,
        });

        const response2 = await generateText({
          model: model2,
          prompt: "Say exactly: 'Hello from Morph!'",
          temperature: 0.1,
          maxTokens: 50,
        });

        console.log("🎉 **SUCCESS with alternative!**");
        console.log("Response:", response2.text);
      } catch (error2) {
        console.log(
          "❌ Test 2 also failed:",
          error2 instanceof Error ? error2.message : String(error2)
        );

        // Test 3: Check if it's a model name issue
        console.log("\n📋 **Test 3: Try with default OpenAI model format**");
        try {
          const model3 = openai("gpt-3.5-turbo", {
            apiKey: morphApiKey,
            baseURL: morphBaseURL,
          });

          const response3 = await generateText({
            model: model3,
            prompt: "Say exactly: 'Hello from Morph!'",
            temperature: 0.1,
            maxTokens: 50,
          });

          console.log("🎉 **SUCCESS with gpt-3.5-turbo model name!**");
          console.log("Response:", response3.text);
          console.log("This suggests the issue might be with the model name");
        } catch (error3) {
          console.log(
            "❌ Test 3 also failed:",
            error3 instanceof Error ? error3.message : String(error3)
          );
          console.log("\n🔍 **All tests failed - investigating further...**");
        }
      }
    }
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  }
}

if (import.meta.main) {
  testOpenAISDKDirect();
}
