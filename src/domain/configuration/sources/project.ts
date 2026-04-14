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
import { log } from "../../../utils/logger";

/**
 * Canonical project configuration location.
 * .minsky/config.yaml is the committed, team-shared config.
 * .minsky/config.local.yaml is the gitignored, local-only overlay (secrets, personal prefs).
 */
const PROJECT_CONFIG_BASE = ".minsky/config.yaml";
const PROJECT_CONFIG_LOCAL = ".minsky/config.local.yaml";

/**
 * Legacy project configuration file locations (for backward compat with older projects)
 */
export const projectConfigFiles = [
  PROJECT_CONFIG_BASE,
  PROJECT_CONFIG_LOCAL,
  "config/local.yaml",
  "config/local.yml",
  "config/local.json",
  ".minsky/config.yml",
  ".minsky/config.json",
  "minsky.config.yaml",
  "minsky.config.yml",
  "minsky.config.json",
] as const;

/**
 * Deep merge two plain objects. Source values override target values.
 */
function deepMergeConfigs(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMergeConfigs(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load project configuration from .minsky/ directory.
 *
 * Reads .minsky/config.yaml (committed base) and deep-merges
 * .minsky/config.local.yaml (gitignored overlay) on top.
 * Falls back to legacy config/ paths for older projects.
 */
export function loadProjectConfiguration(workingDir?: string): Partial<PartialConfiguration> {
  const projectRoot = findProjectRoot(workingDir);
  if (!projectRoot) {
    return {};
  }

  // Try the canonical .minsky/ pair first (base + local overlay)
  const basePath = join(projectRoot, PROJECT_CONFIG_BASE);
  const localPath = join(projectRoot, PROJECT_CONFIG_LOCAL);

  const baseConfig = existsSync(basePath) ? loadConfigFile(basePath) : null;
  const localConfig = existsSync(localPath) ? loadConfigFile(localPath) : null;

  if (baseConfig || localConfig) {
    const base = (baseConfig || {}) as Record<string, unknown>;
    const local = (localConfig || {}) as Record<string, unknown>;
    return deepMergeConfigs(base, local) as Partial<PartialConfiguration>;
  }

  // Fall back to legacy paths for older projects
  const legacyPaths = projectConfigFiles.slice(2); // skip the two canonical paths
  for (const configFile of legacyPaths) {
    const configPath = join(projectRoot, configFile);
    if (existsSync(configPath)) {
      try {
        const config = loadConfigFile(configPath);
        if (config) {
          return config;
        }
      } catch (error) {
        log.warn(
          `Warning: Failed to load project config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return {};
}

/**
 * Load configuration from a specific file
 */
function loadConfigFile(filePath: string): Record<string, unknown> | null {
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
    log.warn(
      `Warning: Failed to parse config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
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
  config: Record<string, unknown>;
  metadata: {
    projectRoot: string | null;
    configFile: string | null;
    searchedPaths: string[];
  };
} {
  const projectRoot = findProjectRoot(workingDir);
  const searchedPaths: string[] = [];
  let configFile: string | null = null;
  let config: Record<string, unknown> = {};

  if (projectRoot) {
    // Try canonical .minsky/ pair first
    const basePath = join(projectRoot, PROJECT_CONFIG_BASE);
    const localPath = join(projectRoot, PROJECT_CONFIG_LOCAL);
    searchedPaths.push(basePath, localPath);

    const baseConfig = existsSync(basePath) ? loadConfigFile(basePath) : null;
    const localConfig = existsSync(localPath) ? loadConfigFile(localPath) : null;

    if (baseConfig || localConfig) {
      config = deepMergeConfigs(
        (baseConfig || {}) as Record<string, unknown>,
        (localConfig || {}) as Record<string, unknown>
      );
      configFile = localConfig ? localPath : basePath;
    } else {
      // Fall back to legacy paths
      for (const relativeConfigFile of projectConfigFiles.slice(2)) {
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

  let _content: string;

  if (format === "json") {
    _content = JSON.stringify(config, null, 2);
  } else {
    // Convert to YAML (simple implementation)
    _content = `# Minsky Project Configuration
# This file is committed to version control and shared across the team

${objectToYaml(config)}`;
  }

  return filePath;
}

/**
 * Simple object to YAML converter (basic implementation)
 */
function objectToYaml(obj: Record<string, unknown>, indent: number = 0): string {
  const spaces = " ".repeat(indent);
  let result = "";

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      result += objectToYaml(value as Record<string, unknown>, indent + 2);
    } else if (Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object") {
          result += `${spaces}  - `;
          result += objectToYaml(item as Record<string, unknown>, indent + 4).replace(/^\s+/, "");
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
