#!/usr/bin/env bun

// Test our database backend implementation directly
import { setupConfiguration } from './src/config-setup';
import { createDatabaseTaskBackend } from './src/domain/tasks/databaseTaskBackend';

console.log('🧪 Testing Database Backend...');

try {
  console.log('⚙️  Setting up configuration...');
  await setupConfiguration();

  console.log('🗄️  Creating database backend...');
  const backend = createDatabaseTaskBackend({ workspacePath: process.cwd() });

  console.log('✅ Backend created successfully');
  console.log('📛 Backend name:', backend.name);
  console.log('📁 Workspace path:', backend.getWorkspacePath());

  console.log('📋 Testing listTasks...');
  const tasks = await backend.listTasks({ limit: 3 });

  console.log('📝 Tasks found:', tasks.length);
  tasks.forEach((task, i) => {
    console.log(`  ${i+1}. ${task.title} (${task.id}) - ${task.status}`);
  });

  console.log('✅ Database backend test completed successfully!');

} catch (error) {
  console.error('❌ Test failed:', error.message);
  console.error('📚 Stack:', error.stack);
  process.exit(1);
}
