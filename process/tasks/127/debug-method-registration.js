// FastMCP Method Registration Debug Script
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

// Create a basic directory for our test
const testDir = path.resolve(process.cwd(), "test-tmp/fastmcp-method-test");
console.log(`Creating test directory: ${testDir}`);

// Create test directory if it doesn't exist
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

// Start the MCP server
console.log("Starting MCP server...");
const mcp = spawn("bun", ["src/cli.ts", "mcp", "start", "--repo", process.cwd()]);

// Buffer to collect the output
let output = "";

// Array to track test steps
const testSteps = [
  {
    name: "Debug List Methods",
    executed: false,
    request: {
      jsonrpc: "2.0",
      id: "debug-1",
      method: "debug.listMethods",
      params: {},
    },
  },
  {
    name: "Direct Task List",
    executed: false,
    request: {
      jsonrpc: "2.0",
      id: "task-1",
      method: "tasks.list",
      params: {
        filter: "TODO",
        limit: 5,
      },
    },
  },
  {
    name: "MCP Tool Execute",
    executed: false,
    request: {
      jsonrpc: "2.0",
      id: "mcp-1",
      method: "mcp.tools.execute",
      params: {
        name: "tasks.list",
        params: {
          filter: "TODO",
          limit: 5,
        },
      },
    },
  },
  {
    name: "Alternative Method Format",
    executed: false,
    request: {
      jsonrpc: "2.0",
      id: "alt-1",
      method: "tasks_list", // Try underscore instead of dot
      params: {
        filter: "TODO",
        limit: 5,
      },
    },
  },
];

// Current test step index
let currentStep = 0;

// Run the next test step
function runNextTest() {
  if (currentStep < testSteps.length) {
    const step = testSteps[currentStep];
    console.log(`\n==== RUNNING TEST: ${step.name} ====`);
    console.log(`REQUEST: ${JSON.stringify(step.request, null, 2)}`);

    mcp.stdin.write(`${JSON.stringify(step.request)  }\n`);
    step.executed = true;
    currentStep++;

    // Schedule next test with delay
    setTimeout(runNextTest, 2000);
  } else {
    console.log("\n==== ALL TESTS COMPLETED ====");
    setTimeout(() => {
      console.log("Test complete, shutting down...");
      mcp.kill("SIGINT");
    }, 1000);
  }
}

// Handle stdout data
mcp.stdout.on("data", (data) => {
  const str = data.toString();
  output += str;
  console.log(`MCP stdout: ${str}`);

  // Only start running tests after MCP server has started
  if (output.includes("Minsky MCP Server started") && currentStep === 0) {
    console.log("\n==== SERVER STARTED, BEGINNING TESTS ====");
    setTimeout(runNextTest, 1000);
  }
});

// Handle stderr data
mcp.stderr.on("data", (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

// Handle process close
mcp.on("close", (code) => {
  console.log(`MCP server exited with code ${code}`);

  // Write the full output to a log file for analysis
  const logFile = path.join(testDir, "debug-output.log");
  fs.writeFileSync(logFile, output);
  console.log(`Full output written to ${logFile}`);
});

// Safety timeout
setTimeout(() => {
  console.log("Safety timeout reached, shutting down...");
  mcp.kill("SIGINT");
}, 30000);
