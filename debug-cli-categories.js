#!/usr/bin/env bun

// Debug script to check CLI category registration
import { setupConfiguration } from './src/config-setup.js';

// Setup configuration first
await setupConfiguration();

// Import registration functions
import { registerAllSharedCommands } from './src/adapters/shared/commands/index.ts';
import { sharedCommandRegistry, CommandCategory } from './src/adapters/shared/command-registry.ts';
import { createModularCliBridge } from './src/adapters/shared/bridges/cli-bridge-modular.ts';

console.log('Registering all commands...');
await registerAllSharedCommands();

console.log('\nAvailable CommandCategory enum values:');
console.log(Object.values(CommandCategory));

console.log('\nAll registered commands:');
const allCommands = sharedCommandRegistry.getAllCommands();
console.log(allCommands.map(cmd => ({ id: cmd.id, category: cmd.category })));

console.log('\nCreating CLI bridge...');
const cliBridge = createModularCliBridge();

console.log('\nAvailable categories from CLI bridge:');
const availableCategories = cliBridge.getAvailableCategories();
console.log(availableCategories);

console.log('\nTools commands specifically:');
const toolsCommands = allCommands.filter(cmd => cmd.id.startsWith('tools.'));
console.log(toolsCommands);

console.log('\nChecking if TOOLS category exists:');
console.log('CategoryExists(TOOLS):', cliBridge.categoryExists(CommandCategory.TOOLS));
console.log('Command count for TOOLS:', cliBridge.getCategoryCommandCount(CommandCategory.TOOLS));

process.exit(0);
