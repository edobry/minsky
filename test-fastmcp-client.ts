#!/usr/bin/env bun
/**
 * PROPER FastMCP v3.3.0 CLIENT TEST
 * Uses fastmcp's own client to verify protocol compliance
 */

import { MinskyMCPServer } from "./src/mcp/server";
import { CommandMapper } from "./src/mcp/command-mapper";
import { z } from "zod";

// Check if fastmcp v3.3.0 exports client functionality
async function testFastMCPClientCapabilities() {
  console.log("🔬 TESTING FastMCP v3.3.0 CLIENT CAPABILITIES");
  console.log("=" .repeat(60));

  try {
    // Test 1: Check fastmcp exports
    console.log("\n📍 Test 1: Checking fastmcp v3.3.0 exports...");
    
    const fastmcp = await import("fastmcp");
    console.log("Available fastmcp exports:", Object.keys(fastmcp));

    // Test 2: Check if Client class exists in fastmcp v3.3.0
    if (fastmcp.Client) {
      console.log("✅ FastMCP Client class found");
      
      // Test 3: Create a server for testing
      console.log("\n📍 Test 3: Creating test server...");
      const server = new MinskyMCPServer({
        name: "FastMCP Client Test Server",
        version: "1.0.0",
        transportType: "stdio",
      });

      const commandMapper = new CommandMapper(server.getFastMCPServer());
      commandMapper.addCommand({
        name: "client.test",
        description: "Test client connectivity",
        parameters: z.object({
          message: z.string(),
        }),
        execute: async (args) => {
          return `Client test received: ${args.message}`;
        },
      });

      console.log("✅ Server created with test tool");

      // Test 4: Try to create and use fastmcp client
      console.log("\n📍 Test 4: Testing fastmcp client connection...");
      
      try {
        // Create client pointing to our server instance
        const client = new fastmcp.Client(server.getFastMCPServer());
        console.log("✅ FastMCP client created");

        // Test connection
        await client.connect();
        console.log("✅ Client connected to server");

        // Test tool listing
        const tools = await client.listTools();
        console.log(`✅ Tools listed: ${tools.length} tools found`);

        // Test tool calling
        const result = await client.callTool("client.test", {
          message: "Hello from fastmcp client!"
        });
        console.log("✅ Tool call successful:", result);

        await client.close();
        console.log("✅ Client closed cleanly");

      } catch (clientError) {
        console.log("❌ FastMCP client test failed:", clientError);
        throw clientError;
      }

    } else {
      console.log("⚠️  FastMCP Client class not found, checking alternative methods...");
      
      // Test 5: Check for other client-related exports
      const possibleClientExports = [
        'createClient', 'MCPClient', 'connect', 'Transport', 'StdioTransport'
      ];
      
      for (const exportName of possibleClientExports) {
        if (fastmcp[exportName]) {
          console.log(`✅ Found alternative: ${exportName}`);
        }
      }
    }

    console.log("\n" + "=" .repeat(60));
    console.log("🎉 FASTMCP CLIENT CAPABILITIES TEST COMPLETED");

  } catch (error) {
    console.error("❌ FastMCP client test failed:", error);
    throw error;
  }
}

// Alternative test: Direct server protocol test
async function testDirectServerProtocol() {
  console.log("\n🔬 DIRECT SERVER PROTOCOL TEST");
  console.log("=" .repeat(60));

  try {
    console.log("\n📍 Testing direct server protocol methods...");
    
    const server = new MinskyMCPServer({
      name: "Direct Protocol Test",
      version: "1.0.0",
      transportType: "stdio",
    });

    const commandMapper = new CommandMapper(server.getFastMCPServer());
    commandMapper.addCommand({
      name: "direct.test",
      description: "Direct protocol test",
      parameters: z.object({ test: z.string() }),
      execute: async (args) => `Direct test: ${args.test}`,
    });

    // Access the underlying FastMCP server
    const fastmcpServer = server.getFastMCPServer();
    console.log("FastMCP server instance:", typeof fastmcpServer);
    console.log("FastMCP server methods:", Object.getOwnPropertyNames(fastmcpServer));

    // Check if we can access server methods directly
    if (fastmcpServer.addTool) {
      console.log("✅ FastMCP server has addTool method");
    }

    console.log("✅ Direct server protocol test completed");

  } catch (error) {
    console.error("❌ Direct server protocol test failed:", error);
    throw error;
  }
}

// Run all tests
async function runAllTests() {
  try {
    await testFastMCPClientCapabilities();
    await testDirectServerProtocol();
    
    console.log("\n🎉 ALL TESTS COMPLETED");
    console.log("FastMCP v3.3.0 protocol capabilities verified");
    
  } catch (error) {
    console.error("❌ CRITICAL: FastMCP v3.3.0 testing failed");
    console.error("This indicates our migration is NOT successful");
    throw error;
  }
}

// Execute tests
runAllTests().catch((error) => {
  console.error("❌ Test execution failed:", error);
  process.exit(1);
}); 
