#!/usr/bin/env bun
/**
 * Debug HTTP transport issues with fastmcp v3.3.0
 */

import { MinskyMCPServer } from "./src/mcp/server";
import { CommandMapper } from "./src/mcp/command-mapper";
import { z } from "zod";

const TEST_PORT = 8082;
const SERVER_URL = `http://localhost:${TEST_PORT}/mcp`;

async function debugHTTPTransport() {
  console.log("🔍 DEBUGGING MCP HTTP TRANSPORT ISSUES");
  
  // Start server
  const server = new MinskyMCPServer({
    name: "Debug MCP Server",
    version: "1.0.0",
    transportType: "httpStream",
    httpStream: {
      endpoint: "/mcp",
      port: TEST_PORT,
    },
  });

  const commandMapper = new CommandMapper(server.getFastMCPServer());
  commandMapper.addCommand({
    name: "debug.test",
    description: "Debug test tool",
    parameters: z.object({}),
    execute: async () => "debug test result",
  });

  await server.start();
  console.log(`Server started on ${SERVER_URL}`);
  
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Test 1: Basic connectivity
  console.log("\n📋 Test 1: Basic HTTP connectivity");
  try {
    const response = await fetch(SERVER_URL, {
      method: "GET"
    });
    console.log(`GET response: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`GET body: ${text}`);
  } catch (error) {
    console.log("GET error:", error);
  }

  // Test 2: POST with minimal JSON-RPC
  console.log("\n📋 Test 2: Minimal JSON-RPC request");
  try {
    const response = await fetch(SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    });
    console.log(`POST response: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`POST body: ${text}`);
  } catch (error) {
    console.log("POST error:", error);
  }

  // Test 3: Different Content-Type
  console.log("\n📋 Test 3: Different Content-Type headers");
  for (const contentType of [
    "application/json",
    "application/json-rpc",
    "application/vnd.api+json",
    "text/plain"
  ]) {
    try {
      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list"
        })
      });
      console.log(`${contentType}: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.log(`${contentType}: ERROR`, error);
    }
  }

  // Test 4: Check what fastmcp version expects
  console.log("\n📋 Test 4: Check FastMCP server details");
  try {
    // @ts-expect-error - accessing internal properties for debugging
    const fastmcpServer = server.getFastMCPServer();
    console.log("FastMCP server type:", typeof fastmcpServer);
    console.log("FastMCP server methods:", Object.getOwnPropertyNames(fastmcpServer));
    
    // @ts-expect-error - checking internal state
    if (fastmcpServer._tools) {
      // @ts-expect-error - checking tools
      console.log("Registered tools:", Object.keys(fastmcpServer._tools));
    }
  } catch (error) {
    console.log("Error inspecting FastMCP:", error);
  }

  process.exit(0);
}

debugHTTPTransport().catch(error => {
  console.error("Debug failed:", error);
  process.exit(1);
}); 
