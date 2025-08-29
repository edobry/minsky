#!/usr/bin/env bun

// Test CLI from session workspace
import { createCli } from './src/cli.ts';

console.log('Creating CLI from session workspace...');

try {
  const program = await createCli();
  
  // Parse help command to see categories
  console.log('\nTesting tools command availability...');
  
  // Check if tools command exists
  const toolsCommand = program.commands.find(cmd => cmd.name() === 'tools');
  
  if (toolsCommand) {
    console.log('✅ tools command found!');
    console.log('Tools command description:', toolsCommand.description());
    
    // Check subcommands
    const subcommands = toolsCommand.commands.map(cmd => cmd.name());
    console.log('Tools subcommands:', subcommands);
  } else {
    console.log('❌ tools command not found');
    console.log('Available commands:', program.commands.map(cmd => cmd.name()));
  }
  
} catch (error) {
  console.error('❌ Error creating CLI:', error.message);
}

process.exit(0);
