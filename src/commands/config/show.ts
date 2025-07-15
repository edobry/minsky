/**
 * minsky config show command
 *
 * Shows the final resolved configuration without showing all sources
 */

import { Command } from "commander";
import config from "config";
import { exit } from "../../utils/process";

interface ShowOptions {
  json?: boolean;
}

export function createConfigShowCommand(): Command {
  return new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd()).action(async (options: ShowOptions) => {
      try {
      // Use node-config directly for resolved configuration
        const resolved = {
          backend: config.get("backend"),
          backendConfig: config.get("backendConfig"),
          credentials: config.get("credentials"),
          sessiondb: config.get("sessiondb"),
          ai: config.has("ai") ? config.get("ai") : undefined,
        };

        if (options.json) {
          await Bun.write(Bun.stdout, `${JSON.stringify(resolved)}\n`);
        } else {
          await displayResolvedConfiguration(resolved);
        }
      } catch (error) {
        await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

async function displayResolvedConfiguration(resolved: any) {
  await Bun.write(Bun.stdout, "RESOLVED CONFIGURATION\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  await Bun.write(Bun.stdout, `Backend: ${resolved.backend}\n`);

  if (Object.keys(resolved.backendConfig).length > 0) {
    await Bun.write(Bun.stdout, "\nBackend Configuration:\n");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        await Bun.write(Bun.stdout, `  ${backend}:\n`);
        for (const [key, value] of Object.entries(config as object)) {
          await Bun.write(Bun.stdout, `    ${key}: ${value}\n`);
        }
      }
    }
  }

  if (Object.keys(resolved.credentials).length > 0) {
    await Bun.write(Bun.stdout, "\nCredentials:\n");
    for (const [service, creds] of Object.entries(resolved.credentials)) {
      if (creds && typeof creds === "object") {
        await Bun.write(Bun.stdout, `  ${service}:\n`);
        const credsObj = creds;
        if (credsObj.source) {
          await Bun.write(Bun.stdout, `    Source: ${credsObj.source}\n`);
        }
        if (credsObj.token) {
          await Bun.write(Bun.stdout, `    Token: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }

  // Backend detection is now handled directly in code (no configuration needed)
}
