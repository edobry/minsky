#!/usr/bin/env bun
/**
 * Test the Fast-Apply Integration
 *
 * This script tests our new fast-apply command implementation to ensure it works correctly.
 */

import { promises as fs } from "fs";

async function testFastApplyIntegration(): Promise<void> {
  console.log("🔧 Testing Fast-Apply Integration\n");

  try {
    // Create a test file
    const testContent = `function greet(name) {
  console.log("Hello, " + name);
}`;

    const testFile = "test-integration.js";
    await fs.writeFile(testFile, testContent);
    console.log("✅ Created test file");

    // Initialize configuration first
    const { CustomConfigFactory, initializeConfiguration } = await import(
      "./src/domain/configuration"
    );
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, {
      workingDirectory: process.cwd(),
    });
    console.log("✅ Configuration initialized");

    // Import our fast-apply command function
    const { registerAiCommands } = await import("./src/adapters/shared/commands/ai");
    const { sharedCommandRegistry } = await import("./src/adapters/shared/command-registry");

    // Register the commands
    registerAiCommands();
    console.log("✅ Registered AI commands");

    // Get the fast-apply command
    const command = sharedCommandRegistry.getCommand("ai.fast-apply");
    if (!command) {
      throw new Error("Fast-apply command not found in registry");
    }
    console.log("✅ Found fast-apply command");

    // Test the command
    const params = {
      filePath: testFile,
      instructions: "Add input validation to check if name parameter is provided",
      dryRun: true,
    };

    console.log("🚀 Executing fast-apply command...");
    const result = await command.execute(params, {} as any);

    console.log("🎉 SUCCESS! Fast-apply command executed successfully");
    console.log("Result:", result || "Command completed");

    // Clean up
    await fs.unlink(testFile);
    console.log("✅ Cleaned up test file");
  } catch (error) {
    console.error("❌ Test failed:", error instanceof Error ? error.message : String(error));

    // Clean up on error
    try {
      await fs.unlink("test-integration.js");
    } catch {
      // Ignore cleanup errors
    }
  }
}

if (import.meta.main) {
  await testFastApplyIntegration();
}
