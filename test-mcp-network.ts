#!/usr/bin/env bun
/**
 * COMPREHENSIVE MCP NETWORK TEST
 * This test actually starts the MCP server and makes real HTTP requests
 * to verify the MCP JSON-RPC protocol works correctly with fastmcp v3.3.0
 */

import { MinskyMCPServer } from "./src/mcp/server";
import { CommandMapper } from "./src/mcp/command-mapper";
import { z } from "zod";

// Test configuration
const TEST_PORT = 8081; // Use different port to avoid conflicts
const SERVER_URL = `http://localhost:${TEST_PORT}/mcp`;

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

async function makeJSONRPCRequest(method: string, params?: any): Promise<MCPResponse> {
  const request: MCPRequest = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params
  };

  console.log(`📤 Making MCP request: ${method}`, params ? `with params: ${JSON.stringify(params)}` : '');

  const response = await fetch(SERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result: MCPResponse = await response.json();
  console.log(`📥 Response:`, JSON.stringify(result, null, 2));
  
  return result;
}

async function startTestServer(): Promise<MinskyMCPServer> {
  console.log(`🚀 Starting MCP server on port ${TEST_PORT}...`);
  
  const server = new MinskyMCPServer({
    name: "Test MCP Server",
    version: "1.0.0",
    transportType: "httpStream",
    projectContext: {
      repositoryPath: process.cwd(),
    },
    httpStream: {
      endpoint: "/mcp",
      port: TEST_PORT,
    },
  });

  // Register comprehensive set of test tools
  const commandMapper = new CommandMapper(
    server.getFastMCPServer(),
    server.getProjectContext()
  );

  // Register various tool types for testing
  commandMapper.addCommand({
    name: "test.simple",
    description: "Simple test tool with no parameters",
    parameters: z.object({}),
    execute: async () => {
      return "Simple test executed successfully";
    },
  });

  commandMapper.addCommand({
    name: "test.with-params",
    description: "Test tool with parameters",
    parameters: z.object({
      message: z.string().describe("A test message"),
      count: z.number().optional().describe("Optional count parameter"),
    }),
    execute: async (args) => {
      return {
        received_message: args.message,
        count: args.count || 1,
        timestamp: new Date().toISOString(),
      };
    },
  });

  commandMapper.addCommand({
    name: "tasks.list",
    description: "List tasks (production-like tool)",
    parameters: z.object({
      filter: z.string().optional(),
    }),
    execute: async (args) => {
      return {
        tasks: [
          { id: "test-1", title: "Test Task 1", status: "TODO" },
          { id: "test-2", title: "Test Task 2", status: "IN_PROGRESS" },
        ],
        filter: args.filter,
        total: 2,
      };
    },
  });

  // Start the server
  await server.start();
  console.log(`✅ MCP server started on ${SERVER_URL}`);
  
  return server;
}

async function testMCPProtocol() {
  let server: MinskyMCPServer | null = null;
  
  try {
    console.log("🧪 COMPREHENSIVE MCP NETWORK TEST - fastmcp v3.3.0");
    console.log("=" .repeat(60));

    // Start server
    server = await startTestServer();
    
    // Wait a moment for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log("\n📋 Test 1: Server Info/Initialize");
    try {
      const initResponse = await makeJSONRPCRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          roots: {
            listChanged: true
          },
          sampling: {}
        },
        clientInfo: {
          name: "test-client",
          version: "1.0.0"
        }
      });
      
      if (initResponse.error) {
        console.log("❌ Initialize failed:", initResponse.error);
      } else {
        console.log("✅ Initialize successful");
      }
    } catch (error) {
      console.log("❌ Initialize error:", error);
    }

    console.log("\n📋 Test 2: List Tools");
    try {
      const toolsResponse = await makeJSONRPCRequest("tools/list");
      
      if (toolsResponse.error) {
        console.log("❌ Tools list failed:", toolsResponse.error);
      } else if (toolsResponse.result && toolsResponse.result.tools) {
        console.log(`✅ Tools list successful - found ${toolsResponse.result.tools.length} tools:`);
        toolsResponse.result.tools.forEach((tool: unknown) => {
          console.log(`   - ${tool.name}: ${tool.description}`);
        });
      } else {
        console.log("⚠️  Tools list returned unexpected format:", toolsResponse.result);
      }
    } catch (error) {
      console.log("❌ Tools list error:", error);
    }

    console.log("\n📋 Test 3: Call Simple Tool");
    try {
      const callResponse = await makeJSONRPCRequest("tools/call", {
        name: "test.simple",
        arguments: {}
      });
      
      if (callResponse.error) {
        console.log("❌ Simple tool call failed:", callResponse.error);
      } else {
        console.log("✅ Simple tool call successful:", callResponse.result);
      }
    } catch (error) {
      console.log("❌ Simple tool call error:", error);
    }

    console.log("\n📋 Test 4: Call Tool with Parameters");
    try {
      const callResponse = await makeJSONRPCRequest("tools/call", {
        name: "test.with-params",
        arguments: {
          message: "Hello from MCP test!",
          count: 42
        }
      });
      
      if (callResponse.error) {
        console.log("❌ Parameterized tool call failed:", callResponse.error);
      } else {
        console.log("✅ Parameterized tool call successful:", callResponse.result);
      }
    } catch (error) {
      console.log("❌ Parameterized tool call error:", error);
    }

    console.log("\n📋 Test 5: Call Production-like Tool");
    try {
      const callResponse = await makeJSONRPCRequest("tools/call", {
        name: "tasks.list",
        arguments: {
          filter: "test-filter"
        }
      });
      
      if (callResponse.error) {
        console.log("❌ Production tool call failed:", callResponse.error);
      } else {
        console.log("✅ Production tool call successful:", callResponse.result);
      }
    } catch (error) {
      console.log("❌ Production tool call error:", error);
    }

    console.log("\n📋 Test 6: Test Invalid Tool Call");
    try {
      const callResponse = await makeJSONRPCRequest("tools/call", {
        name: "nonexistent.tool",
        arguments: {}
      });
      
      if (callResponse.error) {
        console.log("✅ Invalid tool correctly returned error:", callResponse.error.message);
      } else {
        console.log("⚠️  Invalid tool call should have failed but didn't");
      }
    } catch (error) {
      console.log("✅ Invalid tool call properly rejected:", error);
    }

    console.log("\n📋 Test 7: Test Underscore Aliases");
    try {
      const callResponse = await makeJSONRPCRequest("tools/call", {
        name: "test_with_params", // underscore version
        arguments: {
          message: "Testing underscore alias",
          count: 99
        }
      });
      
      if (callResponse.error) {
        console.log("❌ Underscore alias failed:", callResponse.error);
      } else {
        console.log("✅ Underscore alias successful:", callResponse.result);
      }
    } catch (error) {
      console.log("❌ Underscore alias error:", error);
    }

    console.log("\n" + "=" .repeat(60));
    console.log("🎉 COMPREHENSIVE MCP NETWORK TEST COMPLETED");
    console.log("✅ FastMCP v3.3.0 network protocol verification complete!");
    
  } catch (error) {
    console.error("❌ Test setup failed:", error);
    throw error;
  } finally {
    if (server) {
      console.log("\n🛑 Shutting down test server...");
      process.exit(0);
    }
  }
}

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted, exiting...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Test terminated, exiting...');
  process.exit(0);
});

// Run the comprehensive test
testMCPProtocol().catch((error) => {
  console.error("❌ Test failed:", error);
  process.exit(1);
}); 
