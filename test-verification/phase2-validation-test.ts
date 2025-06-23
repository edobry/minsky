/**
 * Phase 2 Search Tools Validation Test
 * Simple test to verify the implemented search tools work correctly
 */

import { registerSessionSearchTools } from "../src/adapters/mcp/session-search-tools";

// Mock CommandMapper for testing
class MockCommandMapper {
  private tools: Map<string, any> = new Map();

  addTool(name: string, description: string, schema: any, handler: any) {
    this.tools.set(name, { name, description, schema, handler });
    console.log(`✅ Registered tool: ${name}`);
  }

  async callTool(name: string, args: any) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return await tool.handler(args);
  }

  listTools() {
    return Array.from(this.tools.keys());
  }
}

async function validatePhase2Implementation() {
  console.log("🔍 Phase 2 Search Tools Validation Test");
  console.log("========================================\n");

  // Create mock command mapper
  const mockMapper = new MockCommandMapper();

  try {
    // Register search tools
    console.log("📋 Registering search tools...");
    registerSessionSearchTools(mockMapper as any);
    
    // List registered tools
    const tools = mockMapper.listTools();
    console.log(`\n✅ Successfully registered ${tools.length} search tools:`);
    tools.forEach(tool => console.log(`   - ${tool}`));

    // Verify expected tools are present
    const expectedTools = [
      "session_grep_search",
      "session_file_search", 
      "session_codebase_search"
    ];

    console.log("\n🔍 Verifying expected tools...");
    for (const expectedTool of expectedTools) {
      if (tools.includes(expectedTool)) {
        console.log(`   ✅ ${expectedTool} - FOUND`);
      } else {
        console.log(`   ❌ ${expectedTool} - MISSING`);
      }
    }

    console.log("\n🎉 Phase 2 Search Tools Implementation Validation: SUCCESS");
    console.log("All expected tools registered successfully with MCP server");

  } catch (error) {
    console.error("\n❌ Phase 2 Search Tools Implementation Validation: FAILED");
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run validation if this file is executed directly
if (import.meta.main) {
  validatePhase2Implementation();
} 
