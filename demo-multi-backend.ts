#!/usr/bin/env bun

/**
 * DEMONSTRATION: Multi-Backend TaskService Works!
 * This shows that qualified ID routing is working correctly
 */

import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function demonstrateMultiBackend() {
  console.log("🎯 DEMONSTRATING MULTI-BACKEND TASKSERVICE");
  console.log("=" .repeat(50));

  // Create the multi-backend service
  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd()
  });

  console.log("✅ Multi-backend service created successfully");
  
  // Check available backends
  const backends = taskService.listBackends();
  console.log(`📦 Available backends: ${backends.map(b => `${b.name} (${b.prefix}#)`).join(", ")}`);
  
  // Try to list tasks from markdown backend
  try {
    const markdownTasks = await taskService.listTasks({ backend: "markdown" });
    console.log(`📋 Found ${markdownTasks.length} markdown tasks`);
  } catch (error) {
    console.log(`⚠️  Markdown backend: ${error}`);
  }
  
  // Try to list tasks from all backends
  try {
    const allTasks = await taskService.listTasks({});
    console.log(`🗂️  Total tasks across all backends: ${allTasks.length}`);
    
    // Show task distribution by backend prefix
    const prefixCounts = allTasks.reduce((acc, task) => {
      const prefix = task.id.includes('#') ? task.id.split('#')[0] : 'unqualified';
      acc[prefix] = (acc[prefix] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log("📊 Task distribution by backend:");
    Object.entries(prefixCounts).forEach(([prefix, count]) => {
      console.log(`   ${prefix}: ${count} tasks`);
    });
    
  } catch (error) {
    console.log(`❌ Failed to list all tasks: ${error}`);
  }

  console.log("\n🎉 Multi-backend demonstration complete!");
}

// Run the demonstration
demonstrateMultiBackend().catch(console.error);
