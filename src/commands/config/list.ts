/**
 * minsky config list command
 *
 * Lists all configuration values from all sources to show where each value comes from
 */

import { Command } from "commander";
import config from "config";
import { exit } from "../../utils/process";

interface ListOptions {
  json?: boolean;
}

export function createConfigListCommand(): Command {
  return new Command("list")
    .description("List all configuration values and their sources")
    .option("--json", "Output in JSON format", false).action(async (options: ListOptions) => {
      try {
      // Use node-config directly - it provides source information via config.util.getConfigSources()
        const sources = config.util.getConfigSources();
        const resolved = {
          backend: config.get("backend"),
          backendConfig: config.get("backendConfig"),
          credentials: config.get("credentials"),
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
    await Bun.write(Bun.stdout, `  ${sources.indexOf(source) + 1}. ${source.name}\n`);
  };

  await Bun.write(Bun.stdout, "\nResolved Configuration:\n");
  await Bun.write(Bun.stdout, `Backend: ${resolved.backend}\n`);
  
  if (resolved.sessiondb) {
    await Bun.write(Bun.stdout, `SessionDB Backend: ${resolved.sessiondb.backend}\n`);
  }

  // Backend detection is now handled directly in code (no configuration needed)

  await Bun.write(Bun.stdout, "\nFor detailed configuration values, use: minsky config show\n");
}
