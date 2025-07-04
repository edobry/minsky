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
    .option("--working-dir <dir>", "Working directory", process.cwd()) as any).action(async (options: ShowOptions) => {
    try {
      // Use node-config directly for resolved configuration
      const resolved = {
        backend: (config as any).get("backend"),
        backendConfig: (config as any).get("backendConfig"),
        credentials: (config as any).get("credentials"),
        sessiondb: (config as any).get("sessiondb"),
        ai: (config as any).has("ai") ? (config as any).get("ai") : undefined as any,
      };

      if ((options as any).json) {
        (process.stdout as any).write(`${JSON.stringify(resolved)}\n`);
      } else {
        displayResolvedConfiguration(resolved);
      }
    } catch (error) {
      (process.stderr as any).write(`Failed to load configuration: ${error}\n`);
      exit(1);
    }
  }) as any;
}

function displayResolvedConfiguration(resolved: any) {
  (process.stdout as any).write("RESOLVED CONFIGURATION\n");
  (process.stdout as any).write(`${"=".repeat(40)}\n`);

  (process.stdout as any).write(`Backend: ${(resolved as any).backend}\n`);

  if ((Object.keys(resolved.backendConfig) as any).length > 0) {
    (process.stdout as any).write("\nBackend Configuration:\n");
    for (const [backend, config] of (Object as any).entries((resolved as any).backendConfig)) {
      if (config && typeof config === "object" && (Object as any).keys(config as object).length > 0) {
        (process.stdout as any).write(`  ${backend}:\n`);
        for (const [key, value] of (Object as any).entries(config as object)) {
          (process.stdout as any).write(`    ${key}: ${value}\n`);
        }
      }
    }
  }

  if ((Object.keys(resolved.credentials) as any).length > 0) {
    (process.stdout as any).write("\nCredentials:\n");
    for (const [service, creds] of (Object as any).entries((resolved as any).credentials)) {
      if (creds && typeof creds === "object") {
        (process.stdout as any).write(`  ${service}:\n`);
        const credsObj = creds as any;
        if ((credsObj as any).source) {
          (process.stdout as any).write(`    Source: ${(credsObj as any).source}\n`);
        }
        if ((credsObj as any).token) {
          (process.stdout as any).write(`    Token: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }

  // Backend detection is now handled directly in code (no configuration needed)
}
