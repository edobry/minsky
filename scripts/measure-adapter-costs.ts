#!/usr/bin/env bun
/**
 * Measure incremental cost of each MCP adapter file after shared commands are loaded.
 * Run from the session root: bun scripts/measure-adapter-costs.ts
 */
import "reflect-metadata";

// Step 1: Simulate what shared_commands_module_loaded already loads
await import("../src/adapters/shared/commands/index");
const t0 = performance.now();

// The full commands/mcp/index.ts cost
await import("../src/commands/mcp/index");
const t1 = performance.now();

console.log(
  "commands/mcp/index.ts cost (after shared/commands/index):",
  `${(t1 - t0).toFixed(1)}ms`
);
console.log("(This is the mcp_command_module_loaded stage delta)");
