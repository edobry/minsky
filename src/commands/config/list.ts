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
  return (new Command("list")
    .description("List all configuration values and their sources")
    .option("--json", "Output in JSON format", false) as any).action(async (options: ListOptions) => {
    try {
      // Use node-config directly - it provides source information via config.util.getConfigSources()
      const sources = (config.util as any).getConfigSources();
      const resolved = {
        backend: (config as any).get("backend"),
        backendConfig: (config as any).get("backendConfig"),
        credentials: (config as any).get("credentials"),
        sessiondb: (config as any).get("sessiondb"),
        ai: (config as any).has("ai") ? (config as any).get("ai") : undefined as any,
      };

      if ((options as any).json) {
        const output = {
          resolved,
          sources: (sources as any).map(source => ({
            name: (source as any).name,
            original: (source as any).original,
            parsed: (source as any).parsed
          }))
        };
        (process.stdout as any).write(`${JSON.stringify(output as any, null, 2)}\n`);
      } else {
        displayConfigurationSources(resolved, sources);
      }
    } catch (error) {
      (process.stderr as any).write(`Failed to load configuration: ${error}\n`);
      exit(1);
    }
  }) as any;
}

function displayConfigurationSources(resolved: any, sources: any[]) {
  (process.stdout as any).write("CONFIGURATION SOURCES\n");
  (process.stdout as any).write(`${"=".repeat(40)}\n`);

  // Show source precedence
  (process.stdout as any).write("Source Precedence (highest to lowest):\n");
  (sources as any).forEach((source, index) => {
    (process.stdout as any).write(`  ${index + 1}. ${(source as any).name}\n`);
  });

  (process.stdout as any).write("\nResolved Configuration:\n");
  (process.stdout as any).write(`Backend: ${(resolved as any).backend}\n`);
  
  if ((resolved as any).sessiondb) {
    (process.stdout as any).write(`SessionDB Backend: ${(resolved.sessiondb as any).backend}\n`);
  }

  // Backend detection is now handled directly in code (no configuration needed)

  (process.stdout as any).write("\nFor detailed configuration values, use: minsky config show\n");
}
