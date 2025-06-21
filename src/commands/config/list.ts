/**
 * minsky config list command
 * 
 * Shows configuration from all sources with proper hierarchy display
 */

import { Command } from "commander";
import { configurationService } from "../../domain/configuration";
import { ConfigurationSources } from "../../domain/configuration/types";
import { log } from "../utils/logger.js";

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
    .action(async (_options: unknown) => {
      try {
        const workingDir = options.workingDir || process.cwd();
        const result = await configurationService.loadConfiguration(_workingDir);
        
        if (_options.json) {
          log.debug(JSON.stringify(result, null, 2));
        } else {
          displayConfigurationSources(result.sources);
          log.debug(`\n${  "=".repeat(60)}`);
          log.debug("RESOLVED CONFIGURATION");
          log.debug("=".repeat(60));
          displayResolvedConfiguration(result.resolved);
        }
      } catch {
        log.error("Failed to load configuration:", error);
        process.exit(1);
      }
    });
}

function displayConfigurationSources(_sources: ConfigurationSources) {
  log.debug("CONFIGURATION SOURCES");
  log.debug("=".repeat(60));

  // CLI Flags
  log.debug("\n1. CLI Flags (highest priority):");
  if (Object.keys(sources.cliFlags).length > 0) {
    displayConfigSection(sources.cliFlags);
  } else {
    log.debug("  (none specified)");
  }

  // Environment Variables
  log.debug("\n2. Environment Variables:");
  if (Object.keys(sources.environment).length > 0) {
    displayConfigSection(sources.environment);
  } else {
    log.debug("  (none set)");
  }

  // Global User Config
  log.debug("\n3. Global User Config (~/.config/minsky/config.yaml):");
  if (sources.globalUser) {
    log.debug(`  Version: ${sources.globalUser.version}`);
    if (sources.globalUser.credentials?.github) {
      log.debug(`  GitHub Credentials: ${sources.globalUser.credentials.github.source} source`);
      if (sources.globalUser.credentials.github.token) {
        log.debug(`    Token: ${"*".repeat(20)} (hidden)`);
      }
      if (sources.globalUser.credentials.github.token_file) {
        log.debug(`    Token File: ${sources.globalUser.credentials.github.token_file}`);
      }
    }
  } else {
    log.debug("  (file not found)");
  }

  // Repository Config
  log.debug("\n4. Repository Config (.minsky/config.yaml):");
  if (sources.repository) {
    log.debug(`  Version: ${sources.repository.version}`);
    if (sources.repository.backends?.default) {
      log.debug(`  Default Backend: ${sources.repository.backends.default}`);
    }
    if (sources.repository.backends?.["github-issues"]) {
      const github = sources.repository.backends["github-issues"];
      log.debug("  GitHub Issues Backend:");
      log.debug(`    Owner: ${github.owner}`);
      log.debug(`    Repo: ${github.repo}`);
    }
    if (sources.repository.repository?.auto_detect_backend !== undefined) {
      log.debug(`  Auto-detect Backend: ${sources.repository.repository.auto_detect_backend}`);
    }
    if (sources.repository.repository?.detection_rules) {
      log.debug(`  Detection Rules: ${sources.repository.repository.detection_rules.length} rules`);
    }
  } else {
    log.debug("  (file not found)");
  }

  // Defaults
  log.debug("\n5. Built-in Defaults (lowest priority):");
  displayConfigSection(sources.defaults);
}

function displayResolvedConfiguration(_resolved: unknown) {
  log.debug(`Backend: ${resolved.backend}`);
  
  if (Object.keys(resolved.backendConfig).length > 0) {
    log.debug("\nBackend Configuration:");
    for (const [backend, config] of Object.entries(resolved.backendConfig)) {
      if (config && typeof config === "object" && Object.keys(config as object).length > 0) {
        log.debug(`  ${backend}:`);
        for (const [key, value] of Object.entries(config as object)) {
          log.debug(`    ${key}: ${value}`);
        }
      }
    }
  }

  if (Object.keys(resolved.credentials).length > 0) {
    log.debug("\nCredentials:");
    for (const [service, creds] of Object.entries(resolved.credentials)) {
      if (creds && typeof creds === "object") {
        log.debug(`  ${service}:`);
        const credsObj = creds as any;
        if (credsObj.source) {
          log.debug(`    Source: ${credsObj.source}`);
        }
        if (credsObj.token) {
          log.debug(`    Token: ${"*".repeat(20)} (hidden)`);
        }
      }
    }
  }

  if (resolved.detectionRules && resolved.detectionRules.length > 0) {
    log.debug("\nDetection Rules:");
    resolved.detectionRules.forEach((_rule: unknown) => {
      log.debug(`  ${index + 1}. ${rule.condition} → ${rule.backend}`);
    });
  }
}

function displayConfigSection(_config: unknown) {
  if (!config || Object.keys(config).length === 0) {
    log.debug("  (empty)");
    return;
  }

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "object" && value !== null) {
      log.debug(`  ${key}:`);
      for (const [subKey, subValue] of Object.entries(value)) {
        log.debug(`    ${subKey}: ${subValue}`);
      }
    } else {
      log.debug(`  ${key}: ${value}`);
    }
  }
} 
