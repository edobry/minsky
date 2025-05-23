// Final test script for MCP server with the correct method name
import { spawn } from "child_process";
import path from "path";

const sessionDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#124";

// Start the MCP server with --repo parameter
console.log("Starting MCP server with repository path...");
const mcp = spawn("bun", [
  path.join(sessionDir, "src/cli.ts"),
  "mcp",
  "start",
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

  // After server starts, send a test command using the correct method name
  if (output.includes("Minsky MCP Server started")) {
    console.log("Server started, sending tasks.list command with repository path...");

    // Note: this is the method name that is registered by the CommandMapper.addTaskCommand method
    mcp.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tasks.list",
        params: {
          all: true,
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

// Close the MCP server after 5 seconds
setTimeout(() => {
  console.log("Test complete, shutting down...");
  mcp.kill("SIGINT");
}, 5000);
