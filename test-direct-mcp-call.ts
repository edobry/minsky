#!/usr/bin/env bun
/**
 * Test Direct MCP Tool Call
 *
 * Shows how we could call MCP tools directly without spawning subprocess
 */

import { setupConfiguration } from "./src/config-setup";

async function testDirectMCPCall() {
  console.log("🧪 **Testing Direct MCP Tool Call**\n");

  try {
    await setupConfiguration();

    console.log("📋 **Current Approach (BAD):**");
    console.log("1. User runs: bun run src/cli.ts mcp call session.edit_file");
    console.log("2. Code spawns: npx @modelcontextprotocol/inspector --cli minsky mcp start");
    console.log("3. Inspector tries to find 'minsky' in PATH");
    console.log("4. ❌ ENOENT - No global minsky installation");

    console.log("\n✅ **Better Approach (DIRECT):**");
    console.log("1. User runs: bun run src/cli.ts mcp call session.edit_file");
    console.log("2. Code calls MCP tool handler directly in same process");
    console.log("3. No subprocess spawning needed");

    // Import our session edit tools directly (like we did in the test)
    const { registerSessionEditTools } = await import("./src/adapters/mcp/session-edit-tools");

    // Create a tool registry
    const tools: Map<string, any> = new Map();
    const mockCommandMapper = {
      addCommand: (tool: any) => {
        tools.set(tool.name, tool);
      },
    };

    // Register tools directly
    registerSessionEditTools(mockCommandMapper as any);

    console.log("\n🔧 **Registered Tools (Direct Access):**");
    for (const [name, tool] of tools) {
      console.log(`  ✅ ${name}: ${tool.description.substring(0, 60)}...`);
    }

    console.log("\n💡 **Implementation Strategy:**");
    console.log("Instead of:");
    console.log("  spawn('minsky', ['mcp', 'start'])");
    console.log("");
    console.log("We should:");
    console.log("  1. Import tool registrations directly");
    console.log("  2. Call tool.handler(args) in same process");
    console.log("  3. Return results without IPC overhead");

    console.log("\n🎯 **Benefits:**");
    console.log("  ✅ No subprocess spawning");
    console.log("  ✅ Works in session repositories");
    console.log("  ✅ Faster execution (no IPC)");
    console.log("  ✅ Better error handling");
    console.log("  ✅ Shared configuration context");
  } catch (error) {
    console.log(`\n❌ Error: ${error}`);
  }
}

if (import.meta.main) {
  testDirectMCPCall();
}
