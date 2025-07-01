/**
 * minsky config list command
 *
 * Lists all configuration values from all sources to show where each value comes from
 */

import { Command } from "commander";
import config from "config";
import { exit } from "../../utils/process.js";

interface ListOptions {
  json?: boolean;
}

export function createConfigListCommand(): Command {
  return new Command("list")
    .description("List all configuration values and their sources")
    .option("--json", "Output in JSON format", false)
    .action(async (options: ListOptions) => {
      try {
        // Use node-config directly - it provides source information via config.util.getConfigSources()
        const sources = config.util.getConfigSources();
        const resolved = {
          backend: config.get("backend"),
          backendConfig: config.get("backendConfig"),
          credentials: config.get("credentials"),
          detectionRules: config.get("detectionRules"),
          sessiondb: config.get("sessiondb"),
          ai: config.has("ai") ? config.get("ai") : undefined,
        };

        if (options.json) {
          const output = {
            resolved,
            sources: sources.map(source => ({
              name: source.name,
              original: source.original,
              parsed: source.parsed
            }))
          };
          // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        } else {
          displayConfigurationSources(resolved, sources);
        }
      } catch (error) {
        // @ts-expect-error - Bun supports process.stderr.write at runtime, types incomplete
        process.stderr.write(`Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

function displayConfigurationSources(resolved: any, sources: any[]) {
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write("CONFIGURATION SOURCES\n");
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write(`${"=".repeat(40)}\n`);

  // Show source precedence
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write("Source Precedence (highest to lowest):\n");
  sources.forEach((source, index) => {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write(`  ${index + 1}. ${source.name}\n`);
  });

  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write("\nResolved Configuration:\n");
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write(`Backend: ${resolved.backend}\n`);
  
  if (resolved.sessiondb) {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write(`SessionDB Backend: ${resolved.sessiondb.backend}\n`);
  }

  if (resolved.detectionRules && resolved.detectionRules.length > 0) {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write(`Detection Rules: ${resolved.detectionRules.length} configured\n`);
  }

  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write("\nFor detailed configuration values, use: minsky config show\n");
}
