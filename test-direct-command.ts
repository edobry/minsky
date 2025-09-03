#!/usr/bin/env bun

import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { modularTasksManager } from "./src/adapters/shared/commands/tasks-modular";

async function main() {
  try {
    console.log("🔧 Registering commands...");
    
    // Register all commands
    modularTasksManager.registerAllCommands();
    
    console.log("🔍 Checking command registration...");
    
    // Check if available command is registered
    const availableCommand = sharedCommandRegistry.getCommand("tasks.available");
    console.log("Available command registered:", !!availableCommand);
    
    const routeCommand = sharedCommandRegistry.getCommand("tasks.route");
    console.log("Route command registered:", !!routeCommand);
    
    if (availableCommand) {
      console.log("✅ Testing available command directly...");
      
      const result = await availableCommand.execute({
        status: "TODO",
        limit: 5,
      });
      
      console.log("Available command result:");
      console.log(result.output || result.error || "No output");
    }
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error);
  }
  
  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
