#!/usr/bin/env bun

// Test script to verify TOOLS category registration
import { setupConfiguration } from './src/config-setup.js';

// Setup configuration first
await setupConfiguration();

// Import registration functions
import { registerAllSharedCommands } from './src/adapters/shared/commands/index.ts';
import { sharedCommandRegistry, CommandCategory } from './src/adapters/shared/command-registry.ts';

console.log('Registering all commands...');
await registerAllSharedCommands();

console.log('\nChecking TOOLS category commands:');
const toolsCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.TOOLS);
console.log('TOOLS category commands:', toolsCommands.map(cmd => cmd.id));

console.log('\nChecking DEBUG category commands with tools prefix:');
const debugCommands = sharedCommandRegistry.getCommandsByCategory(CommandCategory.DEBUG);
const debugToolsCommands = debugCommands.filter(cmd => cmd.id.startsWith('tools.'));
console.log('DEBUG tools commands:', debugToolsCommands.map(cmd => cmd.id));

console.log('\nAll tools.* commands across all categories:');
const allCommands = sharedCommandRegistry.getAllCommands();
const allToolsCommands = allCommands.filter(cmd => cmd.id.startsWith('tools.'));
console.log('All tools commands:', allToolsCommands.map(cmd => ({ id: cmd.id, category: cmd.category })));

process.exit(0);
