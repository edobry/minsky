/**
 * minsky config list command
 * 
 * Shows configuration from all sources with proper hierarchy display
 */

import { Command } from "commander";
import { configurationService } from "../../domain/configuration";
import { ConfigurationSources } from "../../domain/configuration/types";
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
    .action(async (options: ListOptions) => {
      try {
        const workingDir = options.workingDir || process.cwd();
        const result = await configurationService.loadConfiguration(workingDir);
        
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          displayConfigurationSources(result.sources);
          console.log(`\n${  "=".repeat(60)}`);
          console.log("RESOLVED CONFIGURATION");
          console.log("=".repeat(60));
          displayResolvedConfiguration(result.resolved);
        }
      } catch (error) {
        console.error("Failed to load configuration:", error);
        exit(1);
      }
    });
}

function displayConfigurationSources(sources: ConfigurationSources) {
  console.log("CONFIGURATION SOURCES");
  console.log("=".repeat(60));

  // CLI Flags
  console.log("\n1. CLI Flags (highest priority):");
  if (Object.keys(sources.cliFlags).length > 0) {
    displayConfigSection(sources.cliFlags);
  } else {
    console.log("  (none specified)");
  }

  // Environment Variables
  console.log("\n2. Environment Variables:");
  if (Object.keys(sources.environment).length > 0) {
    displayConfigSection(sources.environment);
  } else {
    console.log("  (none set)");
  }

  // Global User Config
  console.log("\n3. Global User Config (~/.config/minsky/config.yaml):");
  if (sources.globalUser) {
    console.log(`  Version: ${sources.globalUser.version}`);
    if (sources.globalUser.credentials?.github) {
      console.log(`  GitHub Credentials: ${sources.globalUser.credentials.github.source} source`);
      if (sources.globalUser.credentials.github.token) {
        console.log(`    Token: ${"*".repeat(20)} (hidden)`);
      }
      if (sources.globalUser.credentials.github.token_file) {
        console.log(`    Token File: ${sources.globalUser.credentials.github.token_file}`);
      }
    }
  } else {
    console.log("  (file not found)");
  }

  // Repository Config
  console.log("\n4. Repository Config (.minsky/config.yaml):");
  if (sources.repository) {
    console.log(`  Version: ${sources.repository.version}`);
    if (sources.repository.backends?.default) {
      console.log(`  Default Backend: ${sources.repository.backends.default}`);
    }
    if (sources.repository.backends?.["github-issues"]) {
      const github = sources.repository.backends["github-issues"];
      console.log("  GitHub Issues Backend:");
      console.log(`    Owner: ${github.owner}`);
      console.log(`    Repo: ${github.repo}`);
    }
    if (sources.repository.repository?.auto_detect_backend !== undefined) {
      console.log(`  Auto-detect Backend: ${sources.repository.repository.auto_detect_backend}`);
    }
    if (sources.repository.repository?.detection_rules) {
      console.log(`  Detection Rules: ${sources.repository.repository.detection_rules.length} rules`);
    }
  } else {
    console.log("  (file not found)");
  }

  // Defaults
  console.log("\n5. Built-in Defaults (lowest priority):");
  displayConfigSection(sources.defaults);
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
