// Test script that uses the direct method name
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

  // After server starts, send a request to the rpc.discover method
  if (output.includes("Minsky MCP Server started")) {
    console.log("Server started, attempting rpc.discover...");

    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "rpc.discover",
        params: {},
      })  }\n`
    );

    // After a short delay, try with different casing for the method name
    setTimeout(() => {
      console.log("Trying with Task.List method name...");
      mcp.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "2",
          method: "Task.List",
          params: {
            all: true,
          },
        })  }\n`
      );
    }, 500);

    // After another delay, try with different casing for the method name
    setTimeout(() => {
      console.log("Trying with task.list method name...");
      mcp.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "3",
          method: "task.list",
          params: {
            all: true,
          },
        })  }\n`
      );
    }, 1000);

    // Also try to execute a non-tasks method
    setTimeout(() => {
      console.log("Trying another method...");
      mcp.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "4",
          method: "help",
          params: {},
        })  }\n`
      );
    }, 1500);
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
