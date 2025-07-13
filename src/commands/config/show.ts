/**
 * minsky config show command
 *
 * Shows the final resolved configuration without showing all sources
 */

import { Command } from "commander";
import config from "config";
import { exit } from "../../utils/process.js";

interface ShowOptions {
  json?: boolean;
}

export function createConfigShowCommand(): Command {
  return (new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd()) as unknown).action(async (options: ShowOptions) => {
    try {
      // Use node-config directly for resolved configuration
      const resolved = {
        backend: (config as unknown).get("backend"),
        backendConfig: (config as unknown).get("backendConfig"),
        credentials: (config as unknown).get("credentials"),
        sessiondb: (config as unknown).get("sessiondb"),
        ai: (config as unknown).has("ai") ? (config as unknown).get("ai") : undefined as unknown,
      };

      if ((options as unknown).json) {
        await Bun.write(Bun.stdout, `${JSON.stringify(resolved)}\n`);
      } else {
        await displayResolvedConfiguration(resolved);
      }
    } catch (error) {
      await Bun.write(Bun.stderr, `Failed to load configuration: ${error}\n`);
      exit(1);
    }
  }) as unknown;
}

async function displayResolvedConfiguration(resolved: any) {
  await Bun.write(Bun.stdout, "RESOLVED CONFIGURATION\n");
  await Bun.write(Bun.stdout, `${"=".repeat(40)}\n`);

  await Bun.write(Bun.stdout, `Backend: ${(resolved as unknown).backend}\n`);

  if ((Object.keys(resolved.backendConfig) as unknown).length > 0) {
    await Bun.write(Bun.stdout, "\nBackend Configuration:\n");
    for (const [backend, config] of (Object as unknown).entries((resolved as unknown).backendConfig)) {
      if (config && typeof config === "object" && (Object as unknown).keys(config as object).length > 0) {
        await Bun.write(Bun.stdout, `  ${backend}:\n`);
        for (const [key, value] of (Object as unknown).entries(config as object)) {
          await Bun.write(Bun.stdout, `    ${key}: ${value}\n`);
        }
      }
    }
  }

  if ((Object.keys(resolved.credentials) as unknown).length > 0) {
    await Bun.write(Bun.stdout, "\nCredentials:\n");
    for (const [service, creds] of (Object as unknown).entries((resolved as unknown).credentials)) {
      if (creds && typeof creds === "object") {
        await Bun.write(Bun.stdout, `  ${service}:\n`);
        const credsObj = creds as unknown;
        if ((credsObj as unknown).source) {
          await Bun.write(Bun.stdout, `    Source: ${(credsObj as unknown).source}\n`);
        }
        if ((credsObj as unknown).token) {
          await Bun.write(Bun.stdout, `    Token: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }

  // Backend detection is now handled directly in code (no configuration needed)
}
