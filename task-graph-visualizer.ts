#!/usr/bin/env bun
/**
 * Task Graph Visualizer
 * 
 * Visualizes task dependencies in different formats
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { createDatabaseConnection } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

interface TaskNode {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  dependents: string[];
}

async function visualizeTaskGraph() {
  const format = process.argv.includes('--mermaid') ? 'mermaid' : 'text';
  const taskId = process.argv.find(arg => arg.startsWith('mt#') || arg.startsWith('md#') || arg.startsWith('gh#'));
  
  try {
    console.log('🔧 Initializing services...');
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true
    });
    
    const db = await createDatabaseConnection();
    const graphService = new TaskGraphService(db);
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd()
    });

    if (taskId) {
      // Show dependencies for specific task
      console.log(`🔍 Dependencies for ${taskId}:`);
      await showTaskDependencies(taskId, graphService, taskService, format);
    } else {
      // Show overview of all tasks with dependencies
      console.log('🔍 Task dependency overview:');
      await showTaskGraphOverview(graphService, taskService, format);
    }

    await (db as any)._.session.client.end();
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Visualization failed:', error.message);
    process.exit(1);
  }
}

async function showTaskDependencies(
  taskId: string, 
  graphService: TaskGraphService, 
  taskService: any,
  format: string
): Promise<void> {
  try {
    const task = await taskService.getTask(taskId);
    const dependencies = await graphService.listDependencies(taskId);
    const dependents = await graphService.listDependents(taskId);

    if (format === 'mermaid') {
      console.log('```mermaid');
      console.log('graph TD');
      
      // Show dependencies (things this task depends on)
      for (const dep of dependencies) {
        console.log(`  ${dep.replace('#', '_')} --> ${taskId.replace('#', '_')}`);
      }
      
      // Show dependents (things that depend on this task)
      for (const dependent of dependents) {
        console.log(`  ${taskId.replace('#', '_')} --> ${dependent.replace('#', '_')}`);
      }
      
      console.log('```');
    } else {
      console.log(`\n📋 Task: ${task?.title || taskId}`);
      console.log(`📊 Status: ${task?.status || 'Unknown'}`);
      
      if (dependencies.length > 0) {
        console.log(`\n⬅️  Dependencies (${taskId} depends on):`);
        for (const dep of dependencies) {
          try {
            const depTask = await taskService.getTask(dep);
            console.log(`  • ${dep}: ${depTask?.title || 'Unknown'} (${depTask?.status || 'Unknown'})`);
          } catch {
            console.log(`  • ${dep}: [Task not found]`);
          }
        }
      } else {
        console.log(`\n⬅️  Dependencies: None`);
      }

      if (dependents.length > 0) {
        console.log(`\n➡️  Dependents (tasks that depend on ${taskId}):`);
        for (const dependent of dependents) {
          try {
            const depTask = await taskService.getTask(dependent);
            console.log(`  • ${dependent}: ${depTask?.title || 'Unknown'} (${depTask?.status || 'Unknown'})`);
          } catch {
            console.log(`  • ${dependent}: [Task not found]`);
          }
        }
      } else {
        console.log(`\n➡️  Dependents: None`);
      }
    }
  } catch (error) {
    console.error(`❌ Error fetching dependencies for ${taskId}:`, error.message);
  }
}

async function showTaskGraphOverview(
  graphService: TaskGraphService, 
  taskService: any,
  format: string
): Promise<void> {
  try {
    // Get all TODO tasks
    const todoTasks = await taskService.listTasks({ 
      status: 'TODO',
      limit: 50 
    });

    console.log(`\n📋 Found ${todoTasks.length} TODO tasks\n`);

    const tasksWithDeps = [];
    
    for (const task of todoTasks) {
      const dependencies = await graphService.listDependencies(task.id);
      const dependents = await graphService.listDependents(task.id);
      
      if (dependencies.length > 0 || dependents.length > 0) {
        tasksWithDeps.push({
          ...task,
          dependencies,
          dependents
        });
      }
    }

    if (format === 'mermaid') {
      console.log('```mermaid');
      console.log('graph TD');
      
      for (const task of tasksWithDeps) {
        for (const dep of task.dependencies) {
          console.log(`  ${dep.replace('#', '_')} --> ${task.id.replace('#', '_')}`);
        }
      }
      
      console.log('```');
    } else {
      console.log(`🔗 Tasks with dependencies (${tasksWithDeps.length}/${todoTasks.length}):\n`);
      
      for (const task of tasksWithDeps) {
        console.log(`📋 ${task.id}: ${task.title.substring(0, 60)}...`);
        
        if (task.dependencies.length > 0) {
          console.log(`  ⬅️  Depends on: ${task.dependencies.join(', ')}`);
        }
        
        if (task.dependents.length > 0) {
          console.log(`  ➡️  Blocks: ${task.dependents.join(', ')}`);
        }
        
        console.log();
      }
      
      if (tasksWithDeps.length === 0) {
        console.log('🔍 No tasks with dependencies found in TODO tasks');
      }
    }
  } catch (error) {
    console.error('❌ Error generating overview:', error.message);
  }
}

if (import.meta.main) {
  visualizeTaskGraph();
}
