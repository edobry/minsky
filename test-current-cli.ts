#!/usr/bin/env bun

/**
 * Test the current CLI state to debug session command issue
 */

async function testCurrentCli() {
  console.log('=== Testing Current CLI State ===\\n');

  try {
    // Import and create CLI exactly as the main CLI does
    const { createCli } = await import('./src/cli.js');
    const cli = await createCli();
    
    console.log('✅ CLI created successfully');
    console.log(`Total commands: ${cli.commands.length}`);
    
    // Find the session command
    const sessionCmd = cli.commands.find(cmd => cmd.name() === 'session');
    
    if (sessionCmd) {
      console.log('\\n📋 Session command found:');
      console.log(`  Name: ${sessionCmd.name()}`);
      console.log(`  Aliases: ${sessionCmd.aliases()}`);  
      console.log(`  Description: ${sessionCmd.description()}`);
      console.log(`  Subcommands: ${sessionCmd.commands.length}`);
      
      console.log('\\n📝 Session subcommands:');
      sessionCmd.commands.forEach((cmd, index) => {
        console.log(`  ${index + 1}. ${cmd.name()} - ${cmd.description()}`);
      });
      
      console.log('\\n🔍 Session command usage:');
      console.log(sessionCmd.helpInformation());
      
    } else {
      console.log('❌ Session command not found in CLI');
    }
    
  } catch (error) {
    console.error('❌ Error creating CLI:', error.message);
    console.error('Stack:', error.stack);
  }
}

testCurrentCli().catch(console.error);