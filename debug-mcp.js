// Debug script for MCP server to list all available methods
import { spawn } from "child_process";
import path from "path";
import { log } from "./src/utils/logger";

const sessionDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#124";

// Start the MCP server with --repo parameter
log.cli("Starting MCP server with repository path...");
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
  log.debug(`MCP stdout: ${str}`);

  // After the server starts, send a request to list all methods
  if (output.includes("Minsky MCP Server started")) {
    log.cli("Server started, requesting method list...");

    mcp.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "debug.listMethods",
      params: {},
    })}\n`);
  }
});

// Handle stderr data
mcp.stderr.on("data", (data) => {
  log.error(`MCP stderr: ${data.toString()}`);
});

// Handle process close
mcp.on("close", (code) => {
  log.cli(`MCP server exited with code ${code}`);
});

// Close the MCP server after 10 seconds
setTimeout(() => {
  log.cli("Test complete, shutting down...");
  mcp.kill("SIGINT");
}, 10000);
