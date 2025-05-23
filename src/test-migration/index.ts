#!/usr/bin/env node

/**
 * Test Migration Tool
 *
 * A tool for migrating Jest/Vitest tests to Bun test patterns
 */

import { Command } from "commander";
import { analyzeCommand } from "./commands/analyze";
import { migrateCommand } from "./commands/migrate";
import { batchCommand } from "./commands/batch";

// Create the command line interface
const program = new Command();

program
  .name("test-migration")
  .description("Tool for migrating Jest/Vitest tests to Bun test patterns")
  .version("0.1.0");

// Add analyze command
program
  .command("analyze")
  .description("Analyze test files and identify migration targets")
  .argument("<files>", "Files or glob patterns to analyze")
  .option("-o, --output <file>", "Output file for analysis results")
  .option("-v, --verbose", "Enable verbose output")
  .action(analyzeCommand);

// Add migrate command
program
  .command("migrate")
  .description("Migrate test files to use Bun patterns")
  .argument("<files>", "Files or glob patterns to migrate")
  .option("-p, --preview", "Preview changes without applying them")
  .option("-s, --safety-level <level>", "Set migration safety level (low, medium, high)", "medium")
  .option("-o, --output <directory>", "Output directory for migrated files")
  .option("-v, --verbose", "Enable verbose output")
  .action(migrateCommand);

// Add batch command
program
  .command("batch")
  .description("Process multiple test files in batch mode")
  .argument("<files>", "Files or glob patterns to process")
  .option("-c, --config <file>", "Configuration file for batch processing")
  .option("-v, --verify", "Verify tests after migration")
  .option("-r, --rollback", "Enable rollback for failed migrations")
  .option("-o, --output <directory>", "Output directory for batch results")
  .action(batchCommand);

// Parse command line arguments
program.parse(process.argv);
