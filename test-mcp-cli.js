// Simple test script for the MCP server that uses the CLI
import { spawn } from "child_process";
import path from "path";

const sessionDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#124";

// Define the command to start the MCP server with the repo parameter
console.log("Starting MCP server with repository path...");
console.log(`Session directory: ${sessionDir}`);

// Start the MCP server
const mcp = spawn("bun", [
  "run",
  path.join(sessionDir, "src/cli.ts"),
  "mcp",
  "start",
  "--stdio",
  "--repo",
  sessionDir,
]);

// Buffer to collect the output
let output = "";

// Handle stdout data
mcp.stdout.on("data", (data) => {
  const str = data.toString();
  output += str;
  console.log(`MCP stdout: ${str}`);

  // When the server is started, send a tasks.list command
  if (output.includes("Minsky MCP Server started")) {
    console.log("Server started, sending tasks.list command...");
    console.log("Repository path from project context should be used automatically");

    mcp.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "mcp.tools.execute",
        params: {
          name: "tasks.list",
          params: {
            all: true,
          },
        },
      }) + "\n"
    );
  }
});

// Handle stderr data
mcp.stderr.on("data", (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

// Handle process close
mcp.on("close", (code) => {
  console.log(`MCP server exited with code ${code}`);
});

// Close the MCP server after 10 seconds
setTimeout(() => {
  console.log("Test complete, shutting down...");
  mcp.kill("SIGINT");
}, 10000);
