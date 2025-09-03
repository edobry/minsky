#!/usr/bin/env bun

import { DatabaseConnectionManager } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";

interface CycleResult {
  hasCycles: boolean;
  cycles: string[][];
  allRelationships: { fromTaskId: string; toTaskId: string }[];
}

/**
 * Detect cycles in task dependency graph using DFS
 */
async function detectCycles(): Promise<CycleResult> {
  const db = await DatabaseConnectionManager.getInstance().getConnection();
  const graphService = new TaskGraphService(db);

  try {
    // Get all relationships
    const allRelationships = await graphService.getAllRelationships();
    console.log(`Found ${allRelationships.length} total relationships`);

    // Build adjacency list
    const graph = new Map<string, string[]>();
    const allTasks = new Set<string>();

    for (const rel of allRelationships) {
      allTasks.add(rel.fromTaskId);
      allTasks.add(rel.toTaskId);

      if (!graph.has(rel.fromTaskId)) {
        graph.set(rel.fromTaskId, []);
      }
      graph.get(rel.fromTaskId)!.push(rel.toTaskId);
    }

    console.log(`Found ${allTasks.size} unique tasks in relationships`);

    // DFS cycle detection
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    function dfs(node: string, path: string[]): boolean {
      if (recursionStack.has(node)) {
        // Found cycle - extract the cycle
        const cycleStart = path.indexOf(node);
        if (cycleStart !== -1) {
          const cycle = [...path.slice(cycleStart), node];
          cycles.push(cycle);
          console.log(`🔄 CYCLE DETECTED: ${cycle.join(" → ")}`);
        }
        return true;
      }

      if (visited.has(node)) {
        return false;
      }

      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (dfs(neighbor, [...path])) {
          // Cycle found in subtree
        }
      }

      recursionStack.delete(node);
      return false;
    }

    // Check each unvisited node
    for (const task of allTasks) {
      if (!visited.has(task)) {
        dfs(task, []);
      }
    }

    return {
      hasCycles: cycles.length > 0,
      cycles,
      allRelationships,
    };
  } finally {
    // DatabaseConnectionManager handles cleanup
  }
}

async function main() {
  try {
    // Initialize configuration first
    console.log("🔧 Initializing configuration...");
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });

    console.log("🔍 Detecting dependency cycles...\n");

    const result = await detectCycles();

    if (result.hasCycles) {
      console.log(`\n❌ FOUND ${result.cycles.length} DEPENDENCY CYCLES:\n`);

      result.cycles.forEach((cycle, index) => {
        console.log(`Cycle ${index + 1}: ${cycle.join(" → ")}`);
      });

      console.log(`\n📋 All relationships for reference:`);
      result.allRelationships.forEach((rel) => {
        console.log(`  ${rel.fromTaskId} → ${rel.toTaskId}`);
      });
    } else {
      console.log("✅ No dependency cycles found!");
    }
  } catch (error) {
    console.error("❌ Cycle detection failed:", error.message);
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
