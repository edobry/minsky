#!/usr/bin/env bun
/**
 * Morph Code Edit API Mapping Demonstration
 *
 * This script shows exactly how we map from Cursor's code_edit format
 * to Morph's OpenAI-compatible API.
 */

// Test data
const originalContent = `function greetUser(name: string) {
  console.log("Hello " + name);
  return "greeting sent";
}`;

const cursorStyleEdit = `function greetUser(name: string) {
  // ... existing code ...
  console.log("Hello " + name + "! Welcome to our app!");
  // ... existing code ...
}`;

function demonstrateAPIMapping() {
  console.log("🔄 **Code Edit API Mapping Flow**\n");

  console.log("📝 **Step 1: Original File Content**");
  console.log(originalContent);

  console.log("\n🎨 **Step 2: Cursor-Style Edit Pattern (Input)**");
  console.log(cursorStyleEdit);

  console.log("\n📡 **Step 3: Generated Prompt (Internal → Morph)**");

  // This is exactly what our system generates (XML format)
  const editInstructions = "I am applying the provided code edits with existing code markers";
  const generatedPrompt = `<instruction>${editInstructions}</instruction>
<code>${originalContent}</code>
<update>${cursorStyleEdit}</update>`;

  console.log(generatedPrompt);

  console.log("\n🌐 **Step 4: HTTP Request to Morph API**");
  const morphAPIRequest = {
    url: "https://api.morphllm.com/v1/chat/completions",
    method: "POST",
    headers: {
      Authorization: "Bearer sk-morph-...",
      "Content-Type": "application/json",
    },
    body: {
      model: "morph-v3-large",
      messages: [
        {
          role: "system",
          content:
            "You are a precise code editor. Return only the final updated file content without any explanations or formatting.",
        },
        {
          role: "user",
          content: generatedPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 8000,
    },
  };

  console.log(JSON.stringify(morphAPIRequest, null, 2));

  console.log("\n📥 **Step 5: Expected Morph API Response**");
  const expectedResponse = {
    choices: [
      {
        message: {
          content: `function greetUser(name: string) {
  console.log("Hello " + name + "! Welcome to our app!");
  return "greeting sent";
}`,
        },
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
    },
  };

  console.log(JSON.stringify(expectedResponse, null, 2));

  console.log("\n✅ **Key Mapping Insights:**");
  console.log("1. 🔄 Cursor's `// ... existing code ...` → Structured prompt instructions");
  console.log("2. 🌐 No special Morph API - uses standard OpenAI chat completions");
  console.log("3. 🎯 Prompt engineering handles the 'edit pattern' concept");
  console.log("4. ⚡ Morph's fast-apply capability comes from model speed, not API format");
  console.log("5. 🔒 Same mapping works for any OpenAI-compatible fast-apply provider");
}

if (import.meta.main) {
  demonstrateAPIMapping();
}
