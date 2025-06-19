// Debug script to test different JSON-RPC method invocation formats
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

// Create a test directory
const testDir = path.resolve(process.cwd(), "test-tmp/jsonrpc-format-test");
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

// Test different JSON-RPC method formats
const testRequests = [
  // 1. Test standard JSON-RPC format for debug.listMethods
  {
    name: "Standard JSON-RPC for Debug Method",
    request: {
      jsonrpc: "2.0",
      id: "1",
      method: "debug.listMethods",
      params: {},
    },
  },
  // 2. Test using method field for tasks.list
  {
    name: "Standard JSON-RPC for Tasks List",
    request: {
      jsonrpc: "2.0",
      id: "2",
      method: "tasks.list",
      params: {
        filter: "TODO",
      },
    },
  },
  // 3. Test legacy MCP format with separate name and params
  {
    name: "Legacy MCP Format (mcp.tools.execute)",
    request: {
      jsonrpc: "2.0",
      id: "3",
      method: "mcp.tools.execute",
      params: {
        name: "tasks.list",
        params: {
          filter: "TODO",
        },
      },
    },
  },
  // 4. Test with method namespaced by underscores instead of dots
  {
    name: "Underscore Format",
    request: {
      jsonrpc: "2.0",
      id: "4",
      method: "tasks_list",
      params: {
        filter: "TODO",
      },
    },
  },
  // 5. Test without namespace
  {
    name: "Without Namespace",
    request: {
      jsonrpc: "2.0",
      id: "5",
      method: "list",
      params: {
        filter: "TODO",
      },
    },
  },
  // 6. Test with namespace but separated by slashes
  {
    name: "Slash Format",
    request: {
      jsonrpc: "2.0",
      id: "6",
      method: "tasks/list",
      params: {
        filter: "TODO",
      },
    },
  },
];

// Current test index
let currentTest = 0;

// Run the next test
function runNextTest() {
  if (currentTest < testRequests.length) {
    const test = testRequests[currentTest];
    console.log(`\n==== TEST ${currentTest + 1}: ${test.name} ====`);
    console.log(`REQUEST: ${JSON.stringify(test.request, null, 2)}`);

    mcp.stdin.write(`${JSON.stringify(test.request)  }\n`);
    currentTest++;

    // Schedule next test with delay
    setTimeout(runNextTest, 2000);
  } else {
    console.log("\n==== ALL TESTS COMPLETED ====");

    // Add some debug data about installed FastMCP version
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
      );
      console.log("\nPackage Information:");
      console.log(`- FastMCP Version: ${packageJson.dependencies?.fastmcp || "Not found"}`);
    } catch (e) {
      console.log(`\nCould not read package.json: ${e.message}`);
    }

    setTimeout(() => {
      console.log("Test complete, shutting down...");
      mcp.kill("SIGINT");

      // Write the full output to a log file for analysis
      const logFile = path.join(testDir, "jsonrpc-format-test.log");
      fs.writeFileSync(logFile, output);
      console.log(`Full output written to ${logFile}`);
    }, 1000);
  }
}

// Handle stdout data
mcp.stdout.on("data", (data) => {
  const str = data.toString();
  output += str;
  console.log(`MCP stdout: ${str}`);

  // Only start running tests after MCP server has started
  if (output.includes("Minsky MCP Server started") && currentTest === 0) {
    console.log("\n==== SERVER STARTED, BEGINNING TESTS ====");
    setTimeout(runNextTest, 1000);
  }
});

// Handle stderr data
mcp.stderr.on("data", (data) => {
  const str = data.toString();
  output += `[stderr] ${str}`;
  console.error(`MCP stderr: ${str}`);
});

// Handle process close
mcp.on("close", (code) => {
  console.log(`MCP server exited with code ${code}`);
});

// Safety timeout
setTimeout(() => {
  console.log("Safety timeout reached, shutting down...");
  mcp.kill("SIGINT");
}, 30000);
