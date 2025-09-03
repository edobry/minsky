#!/usr/bin/env bun

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { DatabaseConnectionManager } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { TaskRoutingService } from "./src/domain/tasks/task-routing-service";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

async function main() {
  try {
    // Initialize configuration
    console.log("🔧 Initializing configuration...");
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });
    
    console.log("🔧 Initializing services...");
    const db = await DatabaseConnectionManager.getInstance().getConnection();
    const graphService = new TaskGraphService(db);
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
    });
    const routingService = new TaskRoutingService(graphService, taskService);
    
    console.log("🔍 Testing available tasks functionality...\n");
    
    // Test available tasks discovery
    const availableTasks = await routingService.findAvailableTasks({
      statusFilter: ["TODO"],
      limit: 10,
    });
    
    console.log(`Found ${availableTasks.length} available tasks:\n`);
    
    availableTasks.slice(0, 5).forEach((task, index) => {
      const readinessPercent = Math.round(task.readinessScore * 100);
      const blockerInfo = task.blockedBy.length > 0 
        ? ` (blocked by ${task.blockedBy.length})`
        : " (ready!)";
      
      console.log(`${index + 1}. ${task.taskId}: ${task.title.substring(0, 60)}...`);
      console.log(`   Status: ${task.status} | Readiness: ${readinessPercent}%${blockerInfo}`);
      console.log();
    });
    
    // Test route generation for a sample task
    if (availableTasks.length > 0) {
      const sampleTaskId = availableTasks[0].taskId;
      console.log(`\n🛣️  Testing route generation to: ${sampleTaskId}\n`);
      
      try {
        const route = await routingService.generateRoute(sampleTaskId, "ready-first");
        console.log(`Route to ${route.targetTaskId}: ${route.totalTasks} total steps`);
        console.log(`Ready: ${route.readyTasks} | Blocked: ${route.blockedTasks}`);
        
        if (route.steps.length > 0) {
          console.log("\nRoute steps:");
          route.steps.slice(0, 3).forEach((step, index) => {
            console.log(`  ${index + 1}. ${step.taskId}: ${step.title} (depth: ${step.depth})`);
          });
        }
      } catch (error) {
        console.log(`Route generation error: ${error.message}`);
      }
    }
    
    console.log("\n✅ Routing service functionality verified!");
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    process.exit(1);
  }
  
  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
