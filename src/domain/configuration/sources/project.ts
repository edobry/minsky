/**
 * Project Configuration Source
 *
 * Loads configuration from project-level configuration files that are committed
 * to the git repository. These provide project-specific defaults and overrides.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { parse } from "yaml";
import type { PartialConfiguration } from "../schemas";

/**
 * Project configuration file locations (relative to project root)
 */
export const projectConfigFiles = [
  "config/local.yaml",
  "config/local.yml",
  "config/local.json",
  ".minsky/config.yaml",
  ".minsky/config.yml",
  ".minsky/config.json",
  "minsky.config.yaml",
  "minsky.config.yml",
  "minsky.config.json",
] as const;

/**
 * Load project configuration from available files
 */
export function loadProjectConfiguration(workingDir?: string): Partial<PartialConfiguration> {
  const projectRoot = findProjectRoot(workingDir);
  if (!projectRoot) {
    return {};
  }

  // Try each configuration file in order
  for (const configFile of projectConfigFiles) {
    const configPath = join(projectRoot, configFile);

    if (existsSync(configPath)) {
      try {
        const config = loadConfigFile(configPath);
        if (config) {
          return config;
        }
      } catch (error) {
        // Log warning but continue to next file
        console.warn(`Warning: Failed to load project config from ${configPath}:`, error);
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
        console.warn(`Warning: Unsupported config file format: ${extension}`);
        return null;
    }
  } catch (error) {
    console.warn(`Warning: Failed to parse config file ${filePath}:`, error);
    return null;
  }
}

/**
 * Find the project root directory by looking for common indicators
 */
function findProjectRoot(startDir?: string): string | null {
  let currentDir = resolve(startDir || process.cwd());

  // Look for project root indicators
  const rootIndicators = [
    "package.json",
    "tsconfig.json",
    ".git",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
  ];

  while (currentDir !== resolve(currentDir, "..")) {
    // Check if this directory contains any root indicators
    const hasRootIndicator = rootIndicators.some((indicator) =>
      existsSync(join(currentDir, indicator))
    );

    if (hasRootIndicator) {
      return currentDir;
    }

    // Move up one directory
    currentDir = resolve(currentDir, "..");
  }

  return null;
}

/**
 * Get project configuration with metadata
 */
export function getProjectConfiguration(workingDir?: string): {
  config: any;
  metadata: {
    projectRoot: string | null;
    configFile: string | null;
    searchedPaths: string[];
  };
} {
  const projectRoot = findProjectRoot(workingDir);
  const searchedPaths: string[] = [];
  let configFile: string | null = null;
  let config: any = {};

  if (projectRoot) {
    // Try each configuration file and track searched paths
    for (const relativeConfigFile of projectConfigFiles) {
      const configPath = join(projectRoot, relativeConfigFile);
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
  }

  return {
    config,
    metadata: {
      projectRoot,
      configFile,
      searchedPaths,
    },
  };
}

/**
 * Validate project configuration file format
 */
export function validateProjectConfigFile(filePath: string): {
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
 * Create a project configuration file with default content
 */
export function createProjectConfigFile(
  projectRoot: string,
  config: PartialConfiguration,
  format: "json" | "yaml" = "yaml"
): string {
  const fileName = format === "json" ? "minsky.config.json" : "minsky.config.yaml";
  const filePath = join(projectRoot, fileName);

  let content: string;

  if (format === "json") {
    content = JSON.stringify(config, null, 2);
  } else {
    // Convert to YAML (simple implementation)
    content = `# Minsky Project Configuration
# This file is committed to version control and shared across the team

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
export const projectSourceMetadata = {
  name: "project",
  description: "Project-level configuration files",
  priority: 25, // Medium-low priority
  required: false,
} as const;
