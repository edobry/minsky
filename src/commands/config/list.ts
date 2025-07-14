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
    .option("--json", "Output in JSON format", false) as unknown).action(async (options: ListOptions) => {
    try {
      // Use node-config directly - it provides source information via config.util.getConfigSources()
      const sources = (config.util as unknown).getConfigSources();
      const resolved = {
        backend: (config as unknown).get("backend"),
        backendConfig: (config as unknown).get("backendConfig"),
        credentials: (config as unknown).get("credentials"),
        sessiondb: (config as unknown).get("sessiondb"),
        ai: (config as unknown).has("ai") ? (config as unknown).get("ai") : undefined as unknown,
      };

      if ((options as unknown).json) {
        const output = {
          resolved,
          sources: (sources as unknown).map(source => ({
            name: (source as unknown).name,
            original: (source as unknown).original,
            parsed: (source as unknown).parsed
          }))
        };
        await Bun.write(Bun.stdout, `${JSON.stringify(output as unknown, undefined, 2)}\n`);
      } else {
        await displayConfigurationSources(resolved, sources);
      }
    } catch (error) {
      await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
      exit(1);
    }
  }) as unknown;
}

async function displayConfigurationSources(resolved: any, sources: any[]) {
  await Bun.write(Bun.stdout, "CONFIGURATION SOURCES\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  // Show source precedence
  await Bun.write(Bun.stdout, "Source Precedence (highest to lowest):\n");
  for (const source of sources) {
    await Bun.write(Bun.stdout, `  ${sources.indexOf(source) + 1}. ${(source as unknown).name}\n`);
  };

  await Bun.write(Bun.stdout, "\nResolved Configuration:\n");
  await Bun.write(Bun.stdout, `Backend: ${(resolved as unknown).backend}\n`);
  
  if ((resolved as unknown).sessiondb) {
    await Bun.write(Bun.stdout, `SessionDB Backend: ${(resolved.sessiondb as unknown).backend}\n`);
  }

  // Backend detection is now handled directly in code (no configuration needed)

  await Bun.write(Bun.stdout, "\nFor detailed configuration values, use: minsky config show\n");
}
