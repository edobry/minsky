#!/usr/bin/env bun

/**
 * Debug script to trace CLI creation timing and command registration order
 */

async function debugCliTiming() {
  console.log('=== CLI Timing Debug ===\\n');

  // 1. Test session commands registration step by step
  console.log('1. Testing step-by-step session command registration...');
  
  // Import command registry first
  const { sharedCommandRegistry } = await import('./src/adapters/shared/command-registry.js');
  console.log('✅ Command registry imported');
  console.log(`Initial command count: ${sharedCommandRegistry.getCommandCount()}`);
  
  // Register session commands only
  console.log('\\n2. Registering ONLY session commands...');
  const { registerSessionCommands } = await import('./src/adapters/shared/commands/session.js');
  registerSessionCommands();
  
  let sessionCommands = sharedCommandRegistry.getCommandsByCategory('SESSION');
  console.log(`After session registration: ${sessionCommands.length} SESSION commands`);
  sessionCommands.forEach(cmd => console.log(`   - ${cmd.id}`));
  
  // Register sessiondb commands  
  console.log('\\n3. Registering sessiondb commands...');
  const { registerSessiondbCommands } = await import('./src/adapters/shared/commands/sessiondb.js');
  registerSessiondbCommands();
  
  sessionCommands = sharedCommandRegistry.getCommandsByCategory('SESSION');
  console.log(`After sessiondb registration: ${sessionCommands.length} SESSION commands`);
  sessionCommands.forEach(cmd => console.log(`   - ${cmd.id}`));
  
  // Test CLI generation after each step
  console.log('\\n4. Testing CLI generation after all registrations...');
  const { CliCommandBridge } = await import('./src/adapters/shared/bridges/cli-bridge.js');
  const bridge = new CliCommandBridge();
  
  const sessionCategoryCmd = bridge.generateCategoryCommand('SESSION', { viaFactory: true });
  if (sessionCategoryCmd) {
    console.log(`✅ Generated session category with ${sessionCategoryCmd.commands.length} subcommands:`);
    sessionCategoryCmd.commands.forEach(cmd => {
      console.log(`   - ${cmd.name()} (${cmd.description()})`);
    });
  } else {
    console.log('❌ Failed to generate session category command');
  }
  
  // 5. Test full CLI creation
  console.log('\\n5. Testing full CLI creation...');
  try {
    const { createCli } = await import('./src/cli.js');
    const cli = await createCli();
    
    const actualSessionCmd = cli.commands.find(cmd => cmd.name() === 'session');
    if (actualSessionCmd) {
      console.log(`✅ CLI session command found with ${actualSessionCmd.commands.length} subcommands:`);
      actualSessionCmd.commands.forEach(cmd => {
        console.log(`   - ${cmd.name()} (${cmd.description()})`);
      });
    } else {
      console.log('❌ CLI session command not found');
    }
  } catch (error) {
    console.error('❌ Failed to create CLI:', error.message);
  }
  
  console.log('\\n=== Debug Complete ===');
}

// Run the debug
debugCliTiming().catch(console.error);