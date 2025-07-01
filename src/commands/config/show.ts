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
  return new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .action(async (options: ShowOptions) => {
      try {
        // Use node-config directly for resolved configuration
        const resolved = {
          backend: config.get("backend"),
          backendConfig: config.get("backendConfig"),
          credentials: config.get("credentials"),
          detectionRules: config.get("detectionRules"),
          sessiondb: config.get("sessiondb"),
          ai: config.has("ai") ? config.get("ai") : undefined,
        };

        if (options.json) {
          // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
          process.stdout.write(`${JSON.stringify(resolved)}\n`);
        } else {
          displayResolvedConfiguration(resolved);
        }
      } catch (error) {
        // @ts-expect-error - Bun supports process.stderr.write at runtime, types incomplete
        process.stderr.write(`Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

function displayResolvedConfiguration(resolved: any) {
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write("RESOLVED CONFIGURATION\n");
  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write(`${"=".repeat(40)}\n`);

  // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
  process.stdout.write(`Backend: ${resolved.backend}\n`);

  if (Object.keys(resolved.backendConfig).length > 0) {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write("\nBackend Configuration:\n");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
        process.stdout.write(`  ${backend}:\n`);
        for (const [key, value] of Object.entries(config as object)) {
          // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
          process.stdout.write(`    ${key}: ${value}\n`);
        }
      }
    }
  }

  if (Object.keys(resolved.credentials).length > 0) {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write("\nCredentials:\n");
    for (const [service, creds] of Object.entries(resolved.credentials)) {
      if (creds && typeof creds === "object") {
        // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
        process.stdout.write(`  ${service}:\n`);
        const credsObj = creds as any;
        if (credsObj.source) {
          // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
          process.stdout.write(`    Source: ${credsObj.source}\n`);
        }
        if (credsObj.token) {
          // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
          process.stdout.write(`    Token: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }

  if (resolved.detectionRules && resolved.detectionRules.length > 0) {
    // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
    process.stdout.write("\nDetection Rules:\n");
    resolved.detectionRules.forEach((rule: any, index: number) => {
      // @ts-expect-error - Bun supports process.stdout.write at runtime, types incomplete
      process.stdout.write(`  ${index + 1}. ${rule.condition} → ${rule.backend}\n`);
    });
  }
}
