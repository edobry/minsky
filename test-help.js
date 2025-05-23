// Test script to check the --repo parameter in the CLI help output
import { spawn } from "child_process";
import path from "path";

const sessionDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/task#124";

// Run the help command
console.log("Checking MCP help output for repository path parameter...");
const help = spawn("bun", [
  path.join(sessionDir, "src/cli.ts"),
  "mcp",
  "start",
  "--help"
]);

// Handle stdout data
help.stdout.on("data", (data) => {
  const output = data.toString();
  console.log(output);

  // Highlight the --repo parameter if found
  if (output.includes("--repo")) {
    const lines = output.split("\n");
    for (const line of lines) {
      if (line.includes("--repo")) {
        console.log("\nRepository parameter found in help output:");
        console.log("👉 " + line);
      }
    }
  } else {
    console.log("\nRepository parameter not found in help output!");
  }
});

// Handle stderr data
help.stderr.on("data", (data) => {
  console.error(`stderr: ${data.toString()}`);
});

// Handle process close
help.on("close", (code) => {
  console.log(`\nHelp command exited with code ${code}`);
}); 
