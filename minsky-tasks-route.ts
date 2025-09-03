#!/usr/bin/env bun

/**
 * Direct CLI implementation for tasks route command
 * Temporary solution until CLI registration is resolved
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { DatabaseConnectionManager } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { TaskRoutingService } from "./src/domain/tasks/task-routing-service";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

interface CliArgs {
  target?: string;
  strategy?: "shortest-path" | "value-first" | "ready-first";
  parallel?: boolean;
  json?: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    strategy: "ready-first",
  };
  
  // First non-flag argument is the target
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") && !result.target) {
      result.target = arg;
      continue;
    }
    
    switch (arg) {
      case "--strategy":
        result.strategy = args[++i] as any;
        break;
      case "--parallel":
        result.parallel = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--help":
        console.log(`
Usage: bun run minsky-tasks-route.ts <target> [options]

Generate implementation route to target task

Arguments:
  target                    Target task ID to generate route for

Options:
  --strategy <strategy>     Routing strategy: ready-first, shortest-path, value-first (default: ready-first)
  --parallel               Show parallel execution opportunities
  --json                   Output in JSON format
  --help                   Show this help message

Examples:
  bun run minsky-tasks-route.ts mt#441
  bun run minsky-tasks-route.ts mt#442 --strategy shortest-path
  bun run minsky-tasks-route.ts mt#237 --parallel --json
        `);
        process.exit(0);
    }
  }
  
  if (!result.target) {
    console.error("❌ Error: Target task ID is required");
    console.error("Usage: bun run minsky-tasks-route.ts <target> [options]");
    console.error("Use --help for more information");
    process.exit(1);
  }
  
  return result;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    
    // Initialize configuration
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });
    
    // Initialize services
    const db = await DatabaseConnectionManager.getInstance().getConnection();
    const graphService = new TaskGraphService(db);
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
    });
    const routingService = new TaskRoutingService(graphService, taskService);
    
    const route = await routingService.generateRoute(args.target!, args.strategy!);

    if (args.json) {
      console.log(JSON.stringify(route, null, 2));
      process.exit(0);
    }

    // Generate human-readable route plan
    console.log(`🎯 Route to ${route.targetTaskId}: ${route.targetTitle}`);
    console.log(`📊 Strategy: ${route.strategy} | Tasks: ${route.totalTasks} | Ready: ${route.readyTasks} | Blocked: ${route.blockedTasks}`);
    console.log(`${"━".repeat(80)}\n`);

    if (route.steps.length === 0) {
      console.log("✅ Target task has no dependencies - ready to start immediately!");
      process.exit(0);
    }

    // Group steps by depth for phase visualization
    const stepsByDepth = new Map<number, typeof route.steps[0][]>();
    for (const step of route.steps) {
      if (!stepsByDepth.has(step.depth)) {
        stepsByDepth.set(step.depth, []);
      }
      stepsByDepth.get(step.depth)!.push(step);
    }

    const maxDepth = Math.max(...Array.from(stepsByDepth.keys()));
    
    for (let depth = maxDepth; depth >= 0; depth--) {
      const stepsAtDepth = stepsByDepth.get(depth);
      if (!stepsAtDepth || stepsAtDepth.length === 0) continue;

      if (depth === 0) {
        console.log(`🎯 **Target Task**`);
      } else {
        console.log(`📋 **Phase ${maxDepth - depth + 1}** (Depth ${depth})`);
      }

      for (const step of stepsAtDepth) {
        const statusIcon = step.status === "DONE" ? "✅" : 
                         step.status === "IN-PROGRESS" ? "🟡" : 
                         step.status === "BLOCKED" ? "🔴" : "⚪";
        const depCount = step.dependencies.length;
        const depText = depCount > 0 ? ` (${depCount} deps)` : "";
        
        console.log(`   ${statusIcon} ${step.taskId}: ${step.title.substring(0, 60)}...${depText}`);
      }
      console.log();
    }

    console.log("💡 Use 'bun run minsky-tasks-available.ts' to see what you can start working on now");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
  
  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
