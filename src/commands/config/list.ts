/**
 * minsky config list command
 *
 * Shows configuration from all sources with proper hierarchy display
 */

import { Command } from "commander";
import nodeConfig from "config";
import { exit } from "../../utils/process.js";

interface ListOptions {
  json?: boolean;
  workingDir?: string;
}

export function createConfigListCommand(): Command {
  return new Command("list")
    .alias("ls")
    .description("List all configuration from all sources")
    .option("--json", "Output in JSON format", false)
    .option("--working-dir <dir>", "Working directory", process.cwd())
    .action((options: ListOptions) => {
      try {
        // Get configuration from node-config
        const resolved = nodeConfig.util.toObject();

        if (options.json) {
          console.log(JSON.stringify(resolved, null, 2));
        } else {
          displayConfigurationSources();
          console.log(`\n${"=".repeat(60)}`);
          console.log("RESOLVED CONFIGURATION");
          console.log("=".repeat(60));
          displayResolvedConfiguration(resolved);
        }
      } catch (error) {
        console.error("Failed to load configuration:", error);
        exit(1);
      }
    });
}

function displayConfigurationSources() {
  console.log("CONFIGURATION SOURCES");
  console.log("=".repeat(60));
  
  console.log("\nnode-config handles configuration precedence automatically:");
  console.log("1. NODE_CONFIG environment variable (highest priority)");
  console.log("2. config/local.yaml (local overrides)");
  console.log("3. config/{NODE_ENV}.yaml (environment-specific)");
  console.log("4. config/default.yaml (base configuration)");
  console.log("5. config/custom-environment-variables.yaml (env var mappings)");
  
  console.log("\nActive configuration files:");
  try {
    const configSources = nodeConfig.util.getConfigSources();
    if (configSources && configSources.length > 0) {
      configSources.forEach((source: any, index: number) => {
        console.log(`  ${index + 1}. ${source.name || "Unknown"}: ${source.parsed ? "loaded" : "not found"}`);
      });
    } else {
      console.log("  Unable to retrieve config sources");
    }
  } catch (error) {
    console.log("  (source information not available)");
  }
}

function displayResolvedConfiguration(resolved: any) {
  console.log(`Backend: ${resolved.backend}`);

  if (Object.keys(resolved.backendConfig).length > 0) {
    console.log("\nBackend Configuration:");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        console.log(`  ${backend}:`);
        for (const [key, value] of Object.entries(config as object)) {
          console.log(`    ${key}: ${value}`);
        }
      }
    }
  }

  if (Object.keys(resolved.credentials).length > 0) {
    console.log("\nCredentials:");
    for (const [service, creds] of Object.entries(resolved.credentials)) {
      if (creds && typeof creds === "object") {
        console.log(`  ${service}:`);
        const credsObj = creds as any;
        if (credsObj.source) {
          console.log(`    Source: ${credsObj.source}`);
        }
        if (credsObj.token) {
          console.log(`    Token: ${"*".repeat(20)} (hidden)`);
        }
      }
    }
  }

  if (resolved.detectionRules && resolved.detectionRules.length > 0) {
    console.log("\nDetection Rules:");
    resolved.detectionRules.forEach((rule: any, index: number) => {
      console.log(`  ${index + 1}. ${rule.condition} → ${rule.backend}`);
    });
  }
}

function displayConfigSection(config: any) {
  if (!config || Object.keys(config).length === 0) {
    console.log("  (empty)");
    return;
  }

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "object" && value !== null) {
      console.log(`  ${key}:`);
      for (const [subKey, subValue] of Object.entries(value)) {
        console.log(`    ${subKey}: ${subValue}`);
      }
    } else {
      console.log(`  ${key}: ${value}`);
    }
  }
}
