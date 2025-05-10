#!/usr/bin/env bun

/**
 * Test script to verify session auto-detection in command-line commands
 * 
 * This script directly runs the 'session dir' and 'session get' commands
 * to verify that auto-detection works when run from a session workspace,
 * and that the --ignore-workspace flag correctly disables auto-detection.
 */

import { spawnSync } from "child_process";
import { join } from "path";

async function testSessionCommands() {
  console.log("Testing session auto-detection in CLI commands");
  console.log("---------------------------------------------");
  
  const cwd = process.cwd();
  console.log(`Current directory: ${cwd}`);
  
  // Run directly without session arg (should auto-detect)
  console.log("\n1. Running 'session dir' without arguments (should auto-detect):");
  const dirResult = spawnSync("bun", ["run", "./src/cli.ts", "session", "dir"], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  
  console.log(`Status: ${dirResult.status === 0 ? "✅ Success" : "❌ Failed"}`);
  console.log(`Output: ${dirResult.stdout.trim()}`);
  if (dirResult.stderr) console.log(`Error: ${dirResult.stderr.trim()}`);
  
  // Run with --ignore-workspace flag (should fail)
  console.log("\n2. Running 'session dir --ignore-workspace' (should require explicit session):");
  const dirIgnoreResult = spawnSync("bun", ["run", "./src/cli.ts", "session", "dir", "--ignore-workspace"], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  
  console.log(`Status: ${dirIgnoreResult.status !== 0 ? "✅ Expected failure" : "❌ Unexpected success"}`);
  if (dirIgnoreResult.stderr) console.log(`Error: ${dirIgnoreResult.stderr.trim()}`);
  
  // Test with get command (should auto-detect)
  console.log("\n3. Running 'session get' without arguments (should auto-detect):");
  const getResult = spawnSync("bun", ["run", "./src/cli.ts", "session", "get"], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  
  console.log(`Status: ${getResult.status === 0 ? "✅ Success" : "❌ Failed"}`);
  console.log(`Output:\n${getResult.stdout.trim()}`);
  if (getResult.stderr) console.log(`Error: ${getResult.stderr.trim()}`);
  
  // Test with get command and --ignore-workspace flag (should fail)
  console.log("\n4. Running 'session get --ignore-workspace' (should require explicit session):");
  const getIgnoreResult = spawnSync("bun", ["run", "./src/cli.ts", "session", "get", "--ignore-workspace"], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  
  console.log(`Status: ${getIgnoreResult.status !== 0 ? "✅ Expected failure" : "❌ Unexpected success"}`);
  if (getIgnoreResult.stderr) console.log(`Error: ${getIgnoreResult.stderr.trim()}`);
  
  // Test with get command and --json flag (should auto-detect and output JSON)
  console.log("\n5. Running 'session get --json' (should auto-detect and output JSON):");
  const getJsonResult = spawnSync("bun", ["run", "./src/cli.ts", "session", "get", "--json"], {
    encoding: "utf-8",
    stdio: "pipe"
  });
  
  console.log(`Status: ${getJsonResult.status === 0 ? "✅ Success" : "❌ Failed"}`);
  try {
    // Try to parse the JSON output
    const jsonOutput = JSON.parse(getJsonResult.stdout.trim());
    console.log("Parsed JSON successfully:", JSON.stringify(jsonOutput, null, 2));
  } catch (e) {
    console.log("Failed to parse JSON output:", getJsonResult.stdout.trim());
  }
  if (getJsonResult.stderr) console.log(`Error: ${getJsonResult.stderr.trim()}`);
}

testSessionCommands().catch(error => {
  console.error("Error running tests:", error);
  process.exit(1);
}); 
