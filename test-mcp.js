#!/usr/bin/env bun

// Simple test client for the MCP server
import readline from "readline";
import { spawn } from "child_process";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Add debug mode with verbose logging
const DEBUG = process.env.DEBUG === "true";

// Start the MCP server with detailed method registration logs
console.log("Starting Minsky MCP Server...");
const mcp = spawn("bun", [
  "src/cli.ts",
  "mcp",
  "start",
  "--repo",
  process.cwd(),
  DEBUG ? "--debug" : "",
]);

// Variable to track if we're ready to accept commands
let serverReady = false;

// Buffer to collect output lines
let outputBuffer = [];

// Setup output handler for the MCP server
mcp.stdout.on("data", (data) => {
  const str = data.toString();
  if (DEBUG) console.log(`[MCP stdout] ${str}`);
  outputBuffer.push(str);

  // Process JSONRPC responses
  try {
    const response = JSON.parse(str);
    // Only show formatted output for JSONRPC responses
    console.log("\nResponse:");
    console.log(JSON.stringify(response, null, 2));
  } catch (e) {
    // Not JSON, might be informational message
    // Don't do anything special with non-JSON output
  }

  // Check if the server is ready to accept commands
  if (str.includes("Minsky MCP Server started")) {
    serverReady = true;
    console.log("\n✅ MCP Server is ready to accept commands");
    promptForCommand();
  }
});

// Handle MCP server errors
mcp.stderr.on("data", (data) => {
  const str = data.toString();
  if (DEBUG) {
    console.log(`[MCP stderr] ${str}`);
  } else if (str.includes("error") || str.includes("Error")) {
    // Only show error messages in non-debug mode
    console.log(`[MCP error] ${str}`);
  }
});

// Register cleanup on exit
process.on("SIGINT", () => {
  console.log("\nShutting down MCP server...");
  mcp.kill("SIGINT");
  process.exit(0);
});

// Prompt for command
function promptForCommand() {
  rl.question("\nEnter a command (or 'help', 'tools', 'quit'): ", (answer) => {
    if (answer === "quit" || answer === "exit") {
      console.log("Shutting down MCP server...");
      mcp.kill("SIGINT");
      process.exit(0);
    } else if (answer === "help") {
      showHelp();
      promptForCommand();
    } else if (answer === "tools") {
      listTools();
    } else if (answer === "buffer") {
      // Show the output buffer for debugging
      console.log("=== Output Buffer ===");
      console.log(outputBuffer.join(""));
      promptForCommand();
    } else {
      try {
        let jsonObject;

        // Check if it's a command shorthand (e.g., "tasks.list" or "tasks_list")
        if (!answer.startsWith("{")) {
          // Parse the command and optional params
          const parts = answer.split(" ");
          const method = parts[0];

          // Build a JSON-RPC request
          jsonObject = {
            jsonrpc: "2.0",
            id: Date.now().toString(),
            method: method,
            params: {},
          };

          // If there are additional params, try to parse them
          if (parts.length > 1) {
            try {
              const paramsStr = parts.slice(1).join(" ");
              jsonObject.params = JSON.parse(paramsStr);
            } catch (e) {
              console.log(`Invalid JSON params: ${parts.slice(1).join(" ")}`);
              promptForCommand();
              return;
            }
          }
        } else {
          // It's a full JSON object
          jsonObject = JSON.parse(answer);
        }

        console.log("Sending request:");
        console.log(JSON.stringify(jsonObject, null, 2));
        mcp.stdin.write(`${JSON.stringify(jsonObject)  }\n`);

        // Log the normalized method name format (for debugging)
        if (DEBUG && jsonObject.method) {
          console.log("[DEBUG] Method format examples:");
          console.log(`- Original: ${jsonObject.method}`);
          console.log(`- Normalized: ${jsonObject.method.replace(/[^a-zA-Z0-9_.]/g, "_")}`);
          console.log(`- Underscore: ${jsonObject.method.replace(/\./g, "_")}`);
        }
      } catch (e) {
        console.log(`Error parsing command: ${e.message}`);
        promptForCommand();
      }
    }
  });
}

// Show help
function showHelp() {
  console.log(`
Available commands:
  help         - Show this help
  tools        - List available tools
  quit/exit    - Exit the test client
  buffer       - Show raw output buffer
  
  {json}       - Send a raw JSON-RPC request
  method_name  - Shorthand for sending a method call (e.g., 'tasks.list')
  method_name {"param":"value"} - Method call with parameters

Examples:
  tasks.list
  tasks.list {"filter":"TODO","limit":5}
  debug.listMethods
  debug.echo {"message":"hello"}
  
  {
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks.list",
    "params": {
      "filter": "TODO",
      "limit": 5
    }
  }
`);
}

// List available tools
function listTools() {
  // Send the debug.listMethods method call
  const request = {
    jsonrpc: "2.0",
    id: "listTools",
    method: "debug.listMethods",
    params: {},
  };

  console.log("Requesting method list...");
  mcp.stdin.write(`${JSON.stringify(request)  }\n`);

  // Also try with underscore format as a fallback
  setTimeout(() => {
    const fallbackRequest = {
      jsonrpc: "2.0",
      id: "listToolsFallback",
      method: "debug_listMethods",
      params: {},
    };

    if (DEBUG) {
      console.log("Trying fallback underscore format...");
      mcp.stdin.write(`${JSON.stringify(fallbackRequest)  }\n`);
    }

    // Continue with prompt regardless
    setTimeout(promptForCommand, 500);
  }, 500);
}

// Wait a bit for the server to start
setTimeout(() => {
  if (!serverReady) {
    console.log("\n⚠️ Server not ready yet, but proceeding anyway...");
    promptForCommand();
  }
}, 2000);
