#!/usr/bin/env bun
/**
 * Test Session Edit Tool Directly
 *
 * Test the session.edit_file tool directly to debug why it's not using fast-apply
 */

import { setupConfiguration } from "./src/config-setup";

async function testSessionEditDirect() {
  console.log("🧪 **Testing Session Edit Tool Directly**\n");

  try {
    await setupConfiguration();

    console.log("📋 **Step 1: Import Session Edit Tools**");
    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");

    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => {
        tools.set(tool.name, tool);
      },
    };

    registerSessionEditTools(mockCommandMapper as any);

    const sessionEditTool = tools.get("session.edit_file");
    if (!sessionEditTool) {
      throw new Error("session.edit_file tool not found");
    }

    console.log("✅ Session edit tool loaded");

    console.log("\n📋 **Step 2: Prepare Test File**");

    // Make sure test file exists with expected content
    const fs = await import("fs/promises");
    await fs.writeFile(
      "test-mcp-fixed.ts",
      `function testMCPFixed() {
  console.log("original content");
  return true;
}`
    );

    console.log("✅ Test file created");

    console.log("\n📋 **Step 3: Test Session Edit with Fast-Apply Content**");

    const editPattern = `function testMCPFixed() {
  // ... existing code ...
  console.log("UPDATED WITH XML FORMAT AND REAL API KEY!");
  // ... existing code ...
}`;

    const args = {
      sessionName: "task249",
      path: "test-mcp-fixed.ts",
      content: editPattern,
      createDirs: false,
    };

    console.log("Edit pattern being used:");
    console.log("```");
    console.log(editPattern);
    console.log("```");

    try {
      console.log("Calling session.edit_file...");
      const result = await sessionEditTool.handler(args);

      console.log("📋 **Raw Result:**");
      console.log(JSON.stringify(result, null, 2));

      if (result.success) {
        console.log("\n🎉 **SUCCESS!**");

        // Check the actual file content
        const updatedContent = await fs.readFile("test-mcp-fixed.ts", "utf-8");
        console.log("\n📝 **Updated File Content:**");
        console.log("```");
        console.log(updatedContent);
        console.log("```");

        if (updatedContent.includes("UPDATED WITH XML FORMAT")) {
          console.log("\n✅ **Fast-apply worked! Session edit tool successfully used Morph!**");
        } else {
          console.log("\n⚠️ **Edit applied but might be legacy fallback**");
        }
      } else {
        console.log("\n❌ **Session Edit Failed:**");
        console.log("Error:", result.error);

        if (result.error && result.error.includes("Could not find content")) {
          console.log("\n🔍 **This error suggests legacy pattern matching was used**");
          console.log("The fast-apply should have handled this correctly");
        }
      }
    } catch (toolError) {
      console.log("\n❌ **Tool Error:**");
      console.log(toolError instanceof Error ? toolError.message : String(toolError));
      console.log("Stack:", toolError instanceof Error ? toolError.stack : "No stack");
    }
  } catch (error) {
    console.log(`\n❌ Setup Error: ${error}`);
  }
}

if (import.meta.main) {
  testSessionEditDirect();
}
