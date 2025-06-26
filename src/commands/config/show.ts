/**
 * minsky config show command
 * 
 * Shows the final resolved configuration without showing all sources
 */

import { Command } from "commander";
import { configurationService } from "../../domain/configuration";
import { exit } from "../../utils/process.js";

interface ShowOptions {
  json?: boolean;
  workingDir?: string;
}

export function createConfigShowCommand(): Command {
  return new Command("show")
    .description("Show the final resolved configuration")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd())
    .action(async (options: ShowOptions) => {
      try {
        const workingDir = options.workingDir || process.cwd();
        const result = await configurationService.loadConfiguration(workingDir);
        
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result.resolved, null, 2)  }\n`);
        } else {
          displayResolvedConfiguration(result.resolved);
        }
      } catch (error) {
        process.stderr.write(`Failed to load configuration: ${error}\n`);
        exit(1);
      }
    });
}

function displayResolvedConfiguration(resolved: any) {
  process.stdout.write("RESOLVED CONFIGURATION\n");
  process.stdout.write(`${"=".repeat(40)  }\n`);
  
  process.stdout.write(`Backend: ${resolved.backend}\n`);
  
  if (Object.keys(resolved.backendConfig).length > 0) {
    process.stdout.write("\nBackend Configuration:\n");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        process.stdout.write(`  ${backend}:\n`);
        for (const [key, value] of Object.entries(config as object)) {
          process.stdout.write(`    ${key}: ${value}\n`);
        }
      }
    }
  }

  if (Object.keys(resolved.credentials).length > 0) {
    process.stdout.write("\nCredentials:\n");
    for (const [service, creds] of Object.entries(resolved.credentials)) {
      if (creds && typeof creds === "object") {
        process.stdout.write(`  ${service}:\n`);
        const credsObj = creds as any;
        if (credsObj.source) {
          process.stdout.write(`    Source: ${credsObj.source}\n`);
        }
        if (credsObj.token) {
          process.stdout.write(`    Token: ${"*".repeat(20)} (hidden)\n`);
        }
      }
    }
  }

  if (resolved.detectionRules && resolved.detectionRules.length > 0) {
    process.stdout.write("\nDetection Rules:\n");
    resolved.detectionRules.forEach((rule: any, index: number) => {
      process.stdout.write(`  ${index + 1}. ${rule.condition} → ${rule.backend}\n`);
    });
  }
} 
