#!/usr/bin/env bun

/**
 * Debug script to trace session command registration issues
 */

async function debugSessionCommands() {
  console.log('=== Session Command Registration Debug ===\\n');

  // 1. Register shared commands
  console.log('1. Registering shared commands...');
  const { registerAllSharedCommands } = await import('./src/adapters/shared/commands/index.js');
  await registerAllSharedCommands();
  console.log('✅ Shared commands registered\\n');

  // 2. Check what's in the shared registry
  console.log('2. Checking shared command registry...');
  const { sharedCommandRegistry } = await import('./src/adapters/shared/command-registry.js');
  const sessionCommands = sharedCommandRegistry.getCommandsByCategory('SESSION');
  console.log(`Found ${sessionCommands.length} session commands:`);
  sessionCommands.forEach(cmd => {
    console.log(`   - ${cmd.id} (name: \"${cmd.name}\")`);
  });
  console.log();

  // 3. Test CLI bridge category command generation
  console.log('3. Testing CLI bridge category command generation...');
  const { CliCommandBridge } = await import('./src/adapters/shared/bridges/cli-bridge.js');
  const bridge = new CliCommandBridge();
  
  const sessionCategoryCommand = bridge.generateCategoryCommand('SESSION', { viaFactory: true });
  if (sessionCategoryCommand) {
    console.log('✅ Session category command generated');
    console.log(`Category command name: \"${sessionCategoryCommand.name()}\"`);
    console.log(`Number of subcommands: ${sessionCategoryCommand.commands.length}`);
    console.log('Subcommands:');
    sessionCategoryCommand.commands.forEach(cmd => {
      console.log(`   - \"${cmd.name()}\" (${cmd.description()})`);
    });
  } else {
    console.log('❌ Failed to generate session category command');
  }
  console.log();

  // 4. Check individual command generation
  console.log('4. Testing individual command generation...');
  const testCommands = ['session.list', 'session.get', 'session.start'];
  for (const cmdId of testCommands) {
    const cmd = bridge.generateCommand(cmdId, { viaFactory: true });
    if (cmd) {
      console.log(`   ✅ ${cmdId} -> \"${cmd.name()}\" (${cmd.description()})`);
    } else {
      console.log(`   ❌ ${cmdId} -> null`);
    }
  }
  console.log();

  // 5. Check CLI factory registration
  console.log('5. Testing CLI factory...');
  const { setupCommonCommandCustomizations } = await import('./src/adapters/cli/setup/command-setup.js');
  setupCommonCommandCustomizations();
  console.log('✅ CLI customizations set up');
  
  // Test category command generation with factory
  const { cliFactory } = await import('./src/adapters/cli/core/cli-command-factory-core.js');
  const factoryCategoryCommand = cliFactory.createCategoryCommand('SESSION');
  if (factoryCategoryCommand) {
    console.log('✅ CLI factory generated session category command');
    console.log(`Factory command name: \"${factoryCategoryCommand.name()}\"`);
    console.log(`Factory subcommands: ${factoryCategoryCommand.commands.length}`);
    factoryCategoryCommand.commands.forEach(cmd => {
      console.log(`   - \"${cmd.name()}\" (${cmd.description()})`);
    });
  } else {
    console.log('❌ CLI factory failed to generate session category command');
  }
  console.log();
}

// Run the debug
debugSessionCommands().catch(console.error);