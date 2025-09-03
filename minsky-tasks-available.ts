#!/usr/bin/env bun

/**
 * Direct CLI implementation for tasks available command
 * Temporary solution until CLI registration is resolved
 */

import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";
import { DatabaseConnectionManager } from "./src/domain/database/connection-manager";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { TaskRoutingService } from "./src/domain/tasks/task-routing-service";
import { createConfiguredTaskService } from "./src/domain/tasks/taskService";

interface CliArgs {
  status?: string;
  backend?: string;
  limit?: number;
  json?: boolean;
  minReadiness?: number;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    limit: 20,
    minReadiness: 0.5,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--status":
        result.status = args[++i];
        break;
      case "--backend":
        result.backend = args[++i];
        break;
      case "--limit":
        result.limit = parseInt(args[++i]) || 20;
        break;
      case "--min-readiness":
        result.minReadiness = parseFloat(args[++i]) || 0.5;
        break;
      case "--json":
        result.json = true;
        break;
      case "--help":
        console.log(`
Usage: bun run minsky-tasks-available.ts [options]

Show tasks currently available to work on (unblocked by dependencies)

Options:
  --status <status>         Filter by task status (default: TODO,IN-PROGRESS)
  --backend <backend>       Filter by specific backend (mt, md, gh, etc.)
  --limit <number>          Maximum number of tasks to show (default: 20)
  --min-readiness <number>  Minimum readiness score 0.0-1.0 (default: 0.5)
  --json                    Output in JSON format
  --help                    Show this help message

Examples:
  bun run minsky-tasks-available.ts
  bun run minsky-tasks-available.ts --status TODO --limit 10
  bun run minsky-tasks-available.ts --backend mt --json
        `);
        process.exit(0);
    }
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

    // Parse status filter
    const statusFilter = args.status
      ? args.status.split(",").map((s: string) => s.trim())
      : ["TODO", "IN-PROGRESS"];

    const availableTasks = await routingService.findAvailableTasks({
      statusFilter,
      backendFilter: args.backend,
      limit: args.limit,
    });

    // Filter by readiness score
    const readyTasks = availableTasks.filter((task) => task.readinessScore >= args.minReadiness!);

    if (args.json) {
      console.log(
        JSON.stringify({ availableTasks: readyTasks, count: readyTasks.length }, null, 2)
      );
      process.exit(0);
    }

    // Generate human-readable output
    console.log(`📋 Available Tasks (${readyTasks.length} unblocked)`);
    console.log(`${"━".repeat(60)}\n`);

    if (readyTasks.length === 0) {
      console.log("No tasks available with current filters.");
      console.log("Try adjusting --status, --backend, or --min-readiness parameters.");
      process.exit(0);
    }

    // Group by readiness level
    const fullyReady = readyTasks.filter((t) => t.readinessScore === 1.0);
    const partiallyReady = readyTasks.filter(
      (t) => t.readinessScore > 0.5 && t.readinessScore < 1.0
    );
    const lowReadiness = readyTasks.filter(
      (t) => t.readinessScore <= 0.5 && t.readinessScore >= args.minReadiness!
    );

    if (fullyReady.length > 0) {
      console.log("🟢 **Fully Ready** (0 blockers)");
      for (const task of fullyReady.slice(0, 10)) {
        const readinessPercent = Math.round(task.readinessScore * 100);
        console.log(
          `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%)`
        );
      }
      console.log();
    }

    if (partiallyReady.length > 0) {
      console.log("🟡 **Partially Ready** (some dependencies complete)");
      for (const task of partiallyReady.slice(0, 5)) {
        const readinessPercent = Math.round(task.readinessScore * 100);
        const blockerCount = task.blockedBy.length;
        console.log(
          `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%, ${blockerCount} blockers)`
        );
      }
      console.log();
    }

    if (lowReadiness.length > 0) {
      console.log("🔴 **Low Readiness** (many dependencies pending)");
      for (const task of lowReadiness.slice(0, 3)) {
        const readinessPercent = Math.round(task.readinessScore * 100);
        const blockerCount = task.blockedBy.length;
        console.log(
          `   ${task.taskId}: ${task.title.substring(0, 50)}... (${task.status}, ${readinessPercent}%, ${blockerCount} blockers)`
        );
      }
    }

    console.log(
      "\n💡 Use 'bun run minsky-tasks-route.ts <task-id>' to see implementation path to any task"
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch(console.error);
}
