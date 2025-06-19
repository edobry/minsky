#!/usr/bin/env bun
/**
 * PROPER MCP PROTOCOL TEST with fastmcp v3.3.0
 * This test uses the official MCP SDK to verify protocol compliance
 */

import { MinskyMCPServer } from "./src/mcp/server";
import { CommandMapper } from "./src/mcp/command-mapper";
import { z } from "zod";

// We need to use the official MCP client to test properly
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_PORT = 8083;

async function testProperMCPProtocol() {
  console.log("🔬 PROPER MCP PROTOCOL TEST - fastmcp v3.3.0");
  console.log("=" .repeat(60));

  try {
    // Test 1: Start MCP server with stdio transport (most reliable)
    console.log("\n📍 Test 1: Starting MCP server with stdio transport...");
    
    const server = new MinskyMCPServer({
      name: "Test Protocol Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: {
        repositoryPath: process.cwd(),
      },
    });

    const commandMapper = new CommandMapper(
      server.getFastMCPServer(),
      server.getProjectContext()
    );

    // Register test tools
    commandMapper.addCommand({
      name: "protocol.test",
      description: "Test protocol compliance",
      parameters: z.object({
        message: z.string(),
      }),
      execute: async (args) => {
        return `Protocol test received: ${args.message}`;
      },
    });

    console.log("✅ Server configured with tools");

    // Test 2: Create MCP client using official SDK
    console.log("\n📍 Test 2: Creating official MCP client...");
    
    const client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // For stdio, we need to create a transport that spawns our server
    // This is the proper way to test MCP servers
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "test-server-stdio.ts"], // We'll create this
    });

    console.log("✅ MCP client created with stdio transport");

    // Test 3: Attempt connection and protocol handshake
    console.log("\n📍 Test 3: Testing MCP protocol handshake...");
    
    try {
      await client.connect(transport);
      console.log("✅ MCP client connected successfully");
      
      // Test 4: List tools via official protocol
      console.log("\n📍 Test 4: Testing tools/list protocol method...");
      const toolsResponse = await client.listTools();
      console.log(`✅ Tools listed successfully: ${toolsResponse.tools.length} tools found`);
      
      for (const tool of toolsResponse.tools) {
        console.log(`   - ${tool.name}: ${tool.description}`);
      }

      // Test 5: Call tool via official protocol  
      console.log("\n📍 Test 5: Testing tools/call protocol method...");
      const callResponse = await client.callTool({
        name: "protocol.test",
        arguments: {
          message: "Hello fastmcp v3.3.0!"
        }
      });
      
      console.log("✅ Tool call successful:");
      console.log(`   Response: ${JSON.stringify(callResponse.content, null, 2)}`);

      await client.close();
      console.log("✅ Client closed cleanly");

    } catch (error) {
      console.log("❌ MCP protocol communication failed:", error);
      throw error;
    }

    console.log("\n" + "=" .repeat(60));
    console.log("🎉 PROPER MCP PROTOCOL TEST COMPLETED SUCCESSFULLY!");
    console.log("✅ FastMCP v3.3.0 protocol compliance verified");

  } catch (error) {
    console.error("❌ Proper protocol test failed:", error);
    throw error;
  }
}

// Create a simple stdio server for testing
async function createTestStdioServer() {
  const serverCode = `
#!/usr/bin/env bun
import { MinskyMCPServer } from "./src/mcp/server";
import { CommandMapper } from "./src/mcp/command-mapper";
import { z } from "zod";

const server = new MinskyMCPServer({
  name: "Test Server",
  version: "1.0.0",
  transportType: "stdio",
});

const commandMapper = new CommandMapper(server.getFastMCPServer());

commandMapper.addCommand({
  name: "protocol.test",
  description: "Test protocol compliance",
  parameters: z.object({
    message: z.string(),
  }),
  execute: async (args) => {
    return \`Protocol test received: \${args.message}\`;
  },
});

if (process.argv.includes("--start")) {
  server.start();
}
`;

  const fs = require('fs');
  fs.writeFileSync('test-server-stdio.ts', serverCode);
  console.log("📝 Created test stdio server file");
}

// Run the test
if (require.main === module) {
  createTestStdioServer().then(() => {
    return testProperMCPProtocol();
  }).catch((error) => {
    console.error("❌ Test failed:", error);
    process.exit(1);
  });
} 
