#!/usr/bin/env bun

import { sharedCommandRegistry } from "./src/adapters/shared/command-registry";
import { modularTasksManager } from "./src/adapters/shared/commands/tasks-modular";

async function main() {
  try {
    console.log("🔧 Registering commands...");
    modularTasksManager.registerAllCommands();

    console.log("\n📋 TASKS category commands:");
    const tasksCommands = sharedCommandRegistry.getCommandsByCategory("TASKS");
    tasksCommands.forEach(cmd => {
      console.log(`  - ${cmd.id} | ${cmd.name} | ${cmd.description}`);
    });

    console.log(`\nTotal TASKS commands: ${tasksCommands.length}`);

    const availableCmd = sharedCommandRegistry.getCommand("tasks.available");
    console.log(`\nAvailable command registered: ${!!availableCmd}`);
    if (availableCmd) {
      console.log(`  ID: ${availableCmd.id}`);
      console.log(`  Name: ${availableCmd.name}`);
      console.log(`  Description: ${availableCmd.description}`);
    }

    const routeCmd = sharedCommandRegistry.getCommand("tasks.route");
    console.log(`\nRoute command registered: ${!!routeCmd}`);
    if (routeCmd) {
      console.log(`  ID: ${routeCmd.id}`);  
      console.log(`  Name: ${routeCmd.name}`);
      console.log(`  Description: ${routeCmd.description}`);
    }

    // Check if deps commands are there for comparison
    const depsAddCmd = sharedCommandRegistry.getCommand("tasks.deps.add");
    console.log(`\nDeps add command registered: ${!!depsAddCmd}`);
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
