#!/usr/bin/env bun

// Test just the tools CLI commands
import { Command } from 'commander';
import { setupConfiguration } from './src/config-setup.js';

// Setup configuration first
await setupConfiguration();

// Import what we need for tools commands only
import { registerToolsCommands } from './src/adapters/shared/commands/tools.ts';
import { sharedCommandRegistry, CommandCategory } from './src/adapters/shared/command-registry.ts';
import { createModularCliBridge } from './src/adapters/shared/bridges/cli-bridge-modular.ts';

console.log('Registering tools commands...');
registerToolsCommands();

console.log('Creating CLI bridge...');
const cliBridge = createModularCliBridge();

console.log('Creating tools category command...');
const toolsCommand = cliBridge.generateCategoryCommand(CommandCategory.TOOLS);

if (toolsCommand) {
  console.log('✅ Tools command generated successfully!');
  console.log('Command name:', toolsCommand.name());
  console.log('Command description:', toolsCommand.description());
  
  // List subcommands
  const subcommands = toolsCommand.commands.map(cmd => ({
    name: cmd.name(),
    description: cmd.description()
  }));
  console.log('Subcommands:', subcommands);
  
  // Create a test program and add the tools command
  const testProgram = new Command()
    .name('test-minsky')
    .description('Test CLI with tools commands');
    
  testProgram.addCommand(toolsCommand);
  
  console.log('\n=== Testing tools --help ===');
  try {
    // This should show tools help
    testProgram.parse(['node', 'test', 'tools', '--help']);
  } catch (error) {
    console.log('Help output completed (this is expected)');
  }
  
} else {
  console.log('❌ Failed to generate tools command');
  console.log('Available categories:', cliBridge.getAvailableCategories());
  console.log('TOOLS category exists:', cliBridge.categoryExists(CommandCategory.TOOLS));
  console.log('TOOLS command count:', cliBridge.getCategoryCommandCount(CommandCategory.TOOLS));
}

process.exit(0);
