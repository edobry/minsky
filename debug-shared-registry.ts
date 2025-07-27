#!/usr/bin/env bun

import { sharedCommandRegistry, CommandCategory } from "./src/adapters/shared/command-registry";
import { registerAllSharedCommands } from "./src/adapters/shared/commands/index";

console.log("🔍 Debugging Shared Command Registry...\n");

// Register all shared commands
console.log("1. Registering all shared commands...");
registerAllSharedCommands();
console.log("   ✓ Completed\n");

// Check all registered commands
console.log("2. All registered commands:");
const allCommands = sharedCommandRegistry.getAllCommands();
console.log(`   Total commands: ${allCommands.length}`);
allCommands.forEach(cmd => {
  console.log(`   - ${cmd.id} (${cmd.category}) - ${cmd.name}`);
});
console.log("");

// Check specifically for RULES category
console.log("3. RULES category commands:");
const rulesCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.RULES);
console.log(`   Rules commands count: ${rulesCommands.length}`);
rulesCommands.forEach(cmd => {
  console.log(`   - ${cmd.id} - ${cmd.name} - ${cmd.description}`);
});
console.log("");

// Check specifically for the generate command
console.log("4. Looking for rules.generate command:");
const generateCommand = sharedCommandRegistry.getCommand("rules.generate");
if (generateCommand) {
  console.log("   ✅ Found rules.generate command!");
  console.log(`   - ID: ${generateCommand.id}`);
  console.log(`   - Name: ${generateCommand.name}`);
  console.log(`   - Category: ${generateCommand.category}`);
  console.log(`   - Description: ${generateCommand.description}`);
} else {
  console.log("   ❌ rules.generate command NOT found!");
}
console.log("");

// Check each category
console.log("5. Commands by category:");
Object.values(CommandCategory).forEach(category => {
  const commands = sharedCommandRegistry.getCommandsByCategory(category);
  console.log(`   ${category}: ${commands.length} commands`);
  commands.forEach(cmd => {
    console.log(`     - ${cmd.id}`);
  });
});