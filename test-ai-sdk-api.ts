#!/usr/bin/env bun
/**
 * Test AI SDK API Patterns
 *
 * Figure out the correct way to use the Vercel AI SDK with custom providers
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

async function testAISDKAPI() {
  console.log("🧪 **Testing AI SDK API Patterns**\n");

  try {
    console.log("📋 **Test 1: Standard OpenAI usage (to understand pattern)**");

    // First let's see if we can make a standard OpenAI call work
    // This will help us understand the correct API pattern
    const model = openai("gpt-3.5-turbo");

    console.log("✅ Model created:", typeof model);

    // The error was about apiKey not being in the settings
    // Maybe the API key is supposed to be set differently

    console.log("\n📋 **Test 2: Check available openai exports**");
    console.log("openai exports:", Object.keys(openai));

    console.log("\n📋 **Test 3: Check what happens with environment variable**");

    // Set the OpenAI API key as environment variable temporarily
    process.env.OPENAI_API_KEY = "sk-proj-xxx...xxxxx";

    const morphModel = openai("gpt-3.5-turbo"); // Use standard model name

    // Now let's see if we can use a custom base URL
    console.log("Model type:", typeof morphModel);

    // The settings might need to be passed differently
    // Let me check if there's a way to configure the base URL

    console.log("\n📋 **Test 4: Try with base URL via environment**");
    process.env.OPENAI_BASE_URL = "https://api.morphllm.com/v1";

    try {
      const response = await generateText({
        model: morphModel,
        prompt: "Say exactly: 'Hello from Morph!'",
        temperature: 0.1,
        maxTokens: 50,
      });

      console.log("🎉 **SUCCESS!**");
      console.log("Response:", response.text);
    } catch (error) {
      console.log("❌ Test failed:", error instanceof Error ? error.message : String(error));

      // Let's check if the openai function accepts a provider config as second parameter
      console.log("\n📋 **Test 5: Investigate openai function parameters**");

      // Maybe the API is different - let's try to see what happens with different approaches
      try {
        // Perhaps there's a createOpenAI function or similar
        const { createOpenAI } = await import("@ai-sdk/openai");
        console.log("✅ createOpenAI found:", typeof createOpenAI);

        // This might be the correct way to create custom providers
        const customOpenAI = createOpenAI({
          apiKey: "sk-proj-xxx...xxxxx",
          baseURL: "https://api.morphllm.com/v1",
        });

        const customModel = customOpenAI("gpt-3.5-turbo");

        const customResponse = await generateText({
          model: customModel,
          prompt: "Say exactly: 'Hello from Morph!'",
          temperature: 0.1,
          maxTokens: 50,
        });

        console.log("🎉 **SUCCESS with createOpenAI!**");
        console.log("Response:", customResponse.text);
      } catch (importError) {
        console.log(
          "❌ createOpenAI not available:",
          importError instanceof Error ? importError.message : String(importError)
        );
      }
    }
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  } finally {
    // Clean up environment variables
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
}

if (import.meta.main) {
  testAISDKAPI();
}
