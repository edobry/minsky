/**
 * User Configuration Source
 *
 * Loads configuration from user-level configuration files stored in the user's
 * home directory following XDG base directory specifications.
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parse } from "yaml";
import { log } from "../../../utils/logger";

/**
 * User configuration file locations
 */
export const userConfigFiles = [
  "config.yaml",
  "config.yml",
  "config.json",
  "local.yaml",
  "local.yml",
  "local.json",
] as const;

/**
 * Get user configuration directory following XDG standards
 */
export function getUserConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, "minsky");
  }

  return join(homedir(), ".config", "minsky");
}

/**
 * Load user configuration from available files
 */
export function loadUserConfiguration(): any {
  const userConfigDir = getUserConfigDir();

  // Try each configuration file in order
  for (const configFile of userConfigFiles) {
    const configPath = join(userConfigDir, configFile);

    if (existsSync(configPath)) {
      try {
        const config = loadConfigFile(configPath);
        if (config) {
          return config;
        }
      } catch (error) {
        // Log warning but continue to next file
        log.warn(`Warning: Failed to load user config from ${configPath}:`, error);
      }
    }
  }

  return {};
}

/**
 * Load configuration from a specific file
 */
function loadConfigFile(filePath: string): any {
  try {
    const content = readFileSync(filePath, "utf8") as string;
    const extension = filePath.split(".").pop()?.toLowerCase();

    switch (extension) {
      case "json":
        return JSON.parse(content);

      case "yaml":
      case "yml":
        return parse(content);

      default:
        log.warn(`Warning: Unsupported config file format: ${extension}`);
        return null;
    }
  } catch (error) {
    log.warn(`Warning: Failed to parse config file ${filePath}:`, error);
    return null;
  }
}

/**
 * Get user configuration with metadata
 */
export function getUserConfiguration(): {
  config: any;
  metadata: {
    configDir: string;
    configFile: string | null;
    searchedPaths: string[];
  };
} {
  const configDir = getUserConfigDir();
  const searchedPaths: string[] = [];
  let configFile: string | null = null;
  let config: any = {};

  // Try each configuration file and track searched paths
  for (const relativeConfigFile of userConfigFiles) {
    const configPath = join(configDir, relativeConfigFile);
    searchedPaths.push(configPath);

    if (existsSync(configPath)) {
      try {
        const loadedConfig = loadConfigFile(configPath);
        if (loadedConfig) {
          config = loadedConfig;
          configFile = configPath;
          break;
        }
      } catch (error) {
        // Continue searching
      }
    }
  }

  return {
    config,
    metadata: {
      configDir,
      configFile,
      searchedPaths,
    },
  };
}

/**
 * Check if user configuration directory exists
 */
export function userConfigDirExists(): boolean {
  return existsSync(getUserConfigDir());
}

/**
 * Validate user configuration file format
 */
export function validateUserConfigFile(filePath: string): {
  valid: boolean;
  error?: string;
  format?: string;
} {
  if (!existsSync(filePath)) {
    return { valid: false, error: "File does not exist" };
  }

  try {
    const extension = filePath.split(".").pop()?.toLowerCase();

    if (!["json", "yaml", "yml"].includes(extension || "")) {
      return { valid: false, error: `Unsupported file format: ${extension}` };
    }

    const content = readFileSync(filePath, "utf8") as string;

    switch (extension) {
      case "json":
        JSON.parse(content);
        return { valid: true, format: "json" };

      case "yaml":
      case "yml":
        parse(content);
        return { valid: true, format: "yaml" };

      default:
        return { valid: false, error: `Unknown format: ${extension}` };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Create user configuration directory if it doesn't exist
 */
export function ensureUserConfigDir(): string {
  const configDir = getUserConfigDir();

  try {
    const fs = require("fs");
    fs.mkdirSync(configDir, { recursive: true });
  } catch (error) {
    log.warn(`Warning: Failed to create user config directory ${configDir}:`, error);
  }

  return configDir;
}

/**
 * Create a user configuration file with default content
 */
export function createUserConfigFile(config: any, format: "json" | "yaml" = "yaml"): string {
  const configDir = ensureUserConfigDir();
  const fileName = format === "json" ? "config.json" : "config.yaml";
  const filePath = join(configDir, fileName);

  let content: string;

  if (format === "json") {
    content = JSON.stringify(config, null, 2);
  } else {
    // Convert to YAML (simple implementation)
    content = `# Minsky User Configuration
# This file contains your personal configuration settings
# It is stored in your user profile and not shared with others

${objectToYaml(config)}`;
  }

  return filePath;
}

/**
 * Simple object to YAML converter (basic implementation)
 */
function objectToYaml(obj: any, indent: number = 0): string {
  const spaces = " ".repeat(indent);
  let result = "";

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      result += objectToYaml(value, indent + 2);
    } else if (Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object") {
          result += `${spaces}  - `;
          result += objectToYaml(item, indent + 4).replace(/^\s+/, "");
        } else {
          result += `${spaces}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else {
      result += `${spaces}${key}: ${JSON.stringify(value)}\n`;
    }
  }

  return result;
}

/**
 * Configuration source metadata
 */
export const userSourceMetadata = {
  name: "user",
  description: "User-level configuration files",
  priority: 50, // Medium priority
  required: false,
} as const;
