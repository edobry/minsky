#!/usr/bin/env bun
import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// Path to our test helper script
const TEST_HELPER_PATH = "test-session-mock-helper.ts";

// Set up session name for auto-detection via environment variable
const ENV_VARS = {
  MINSKY_TEST_CURRENT_SESSION: "auto-detected-session",
};

console.log("Testing session commands with auto-detection");
console.log("--------------------------------------------");

// Test session dir command with auto-detection
const dirResult = spawnSync("bun", ["run", TEST_HELPER_PATH, "session", "dir"], {
  encoding: "utf-8",
  env: { ...process.env, ...ENV_VARS },
});

console.log("\nTesting 'session dir' with auto-detection:");
console.log(`Status: ${dirResult.status}`);
console.log(`Output: ${dirResult.stdout}`);
if (dirResult.stderr) {
  console.log(`Error: ${dirResult.stderr}`);
}

// Test session get command with auto-detection
const getResult = spawnSync("bun", ["run", TEST_HELPER_PATH, "session", "get"], {
  encoding: "utf-8",
  env: { ...process.env, ...ENV_VARS },
});

console.log("\nTesting 'session get' with auto-detection:");
console.log(`Status: ${getResult.status}`);
console.log(`Output: ${getResult.stdout}`);
if (getResult.stderr) {
  console.log(`Error: ${getResult.stderr}`);
}

// Test session get --json with auto-detection
const getJsonResult = spawnSync("bun", ["run", TEST_HELPER_PATH, "session", "get", "--json"], {
  encoding: "utf-8",
  env: { ...process.env, ...ENV_VARS },
});

console.log("\nTesting 'session get --json' with auto-detection:");
console.log(`Status: ${getJsonResult.status}`);
console.log(`Output: ${getJsonResult.stdout}`);
if (getJsonResult.stderr) {
  console.log(`Error: ${getJsonResult.stderr}`);
}

// Test with explicit session name override
const explicitResult = spawnSync(
  "bun",
  ["run", TEST_HELPER_PATH, "session", "get", "explicit-session"],
  {
    encoding: "utf-8",
    env: { ...process.env, ...ENV_VARS },
  }
);

console.log("\nTesting with explicit session override:");
console.log(`Status: ${explicitResult.status}`);
console.log(`Output: ${explicitResult.stdout}`);
if (explicitResult.stderr) {
  console.log(`Error: ${explicitResult.stderr}`);
}

// Test with --ignore-workspace
const ignoreResult = spawnSync(
  "bun",
  ["run", TEST_HELPER_PATH, "session", "get", "--ignore-workspace"],
  {
    encoding: "utf-8",
    env: { ...process.env, ...ENV_VARS },
  }
);

console.log("\nTesting with --ignore-workspace flag:");
console.log(`Status: ${ignoreResult.status}`);
console.log(`Output: ${ignoreResult.stdout}`);
if (ignoreResult.stderr) {
  console.log(`Error: ${ignoreResult.stderr}`);
}

console.log("\nTests complete!");
