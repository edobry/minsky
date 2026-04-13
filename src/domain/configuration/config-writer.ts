/**
 * Configuration Writer
 *
 * Handles writing configuration changes to user configuration files with
 * backup functionality and validation.
 */

import { join, dirname } from "path";
import { parse, stringify } from "yaml";
import {
  getUserConfigDir as defaultGetUserConfigDir,
  userConfigFiles as defaultUserConfigFiles,
} from "./sources/user";
import { ConfigSchema } from "./config-schemas";
import { log } from "../../utils/logger";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";

/**
 * Configuration writer options
 */
export interface ConfigWriterOptions {
  /** Create backup before modifying */
  createBackup?: boolean;
  /** File format to use (defaults to yaml) */
  format?: "yaml" | "json";
  /** Whether to create the config directory if it doesn't exist */
  createDir?: boolean;
  /** Whether to validate the configuration before writing */
  validate?: boolean;
  /** Override the user config directory (for tests) */
  configDir?: string;
}

/**
 * Configuration modification result
 */
export interface ConfigModificationResult {
  success: boolean;
  filePath: string;
  backupPath?: string;
  previousValue?: unknown;
  newValue?: unknown;
  error?: string;
}

/**
 * Configuration backup result
 */
export interface ConfigBackupResult {
  success: boolean;
  originalPath: string;
  backupPath: string;
  error?: string;
}

/**
 * Configuration writer class
 */
export class ConfigWriter {
  private readonly options: Required<ConfigWriterOptions>;
  private readonly configDir: string;
  private readonly fs: FsLike;
  private readonly userConfigFiles: readonly string[];

  constructor(
    options: ConfigWriterOptions = {},
    deps?: {
      fs?: FsLike;
      getUserConfigDir?: () => string;
      userConfigFiles?: readonly string[];
    }
  ) {
    this.options = {
      createBackup: true,
      format: "yaml",
      createDir: true,
      validate: true,
      configDir: options.configDir,
      ...options,
    } as Required<ConfigWriterOptions>;

    const getUserConfigDir = deps?.getUserConfigDir ?? defaultGetUserConfigDir;
    this.userConfigFiles = deps?.userConfigFiles ?? defaultUserConfigFiles;
    this.configDir = this.options.configDir || getUserConfigDir();
    this.fs = deps?.fs ?? createRealFs();
  }

  /**
   * Set a configuration value by key path
   */
  async setConfigValue(keyPath: string, value: unknown): Promise<ConfigModificationResult> {
    try {
      // Ensure config directory exists
      if (this.options.createDir) {
        await this.ensureConfigDir();
      }

      // Find or create config file
      const configFile = await this.findOrCreateConfigFile();

      // Load current configuration
      const currentConfig = await this.loadConfigFile(configFile);

      // Create backup if requested (only if file exists)
      let backupPath: string | undefined;
      if (this.options.createBackup && (await this.fs.exists(configFile))) {
        const backupResult = await this.createBackup(configFile);
        if (!backupResult.success) {
          return {
            success: false,
            filePath: configFile,
            error: `Backup failed: ${backupResult.error}`,
          };
        }
        backupPath = backupResult.backupPath;
      }

      // Get previous value for reporting
      const previousValue = this.getNestedValue(currentConfig, keyPath);

      // Set new value
      this.setNestedValue(currentConfig, keyPath, value);

      // Validate configuration if requested
      if (this.options.validate) {
        const validationResult = ConfigSchema.safeParse(currentConfig);
        if (!validationResult.success) {
          // Restore from backup if validation fails
          if (backupPath) {
            await this.restoreFromBackup(configFile, backupPath);
          }
          return {
            success: false,
            filePath: configFile,
            backupPath,
            error: `Validation failed: ${validationResult.error.message}`,
          };
        }
      }

      // Write updated configuration
      await this.writeConfigFile(configFile, currentConfig);

      log.debug(`Config value set: ${keyPath} = ${JSON.stringify(value)}`);

      return {
        success: true,
        filePath: configFile,
        backupPath,
        previousValue,
        newValue: value,
      };
    } catch (error) {
      return {
        success: false,
        filePath: this.getConfigFilePath(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Unset (remove) a configuration value by key path
   */
  async unsetConfigValue(keyPath: string): Promise<ConfigModificationResult> {
    try {
      // Find existing config file
      const configFile = await this.findConfigFile();
      if (!configFile) {
        return {
          success: false,
          filePath: this.getConfigFilePath(),
          error: "No configuration file found to modify",
        };
      }

      // Load current configuration
      const currentConfig = await this.loadConfigFile(configFile);

      // Get previous value for reporting
      const previousValue = this.getNestedValue(currentConfig, keyPath);
      if (previousValue === undefined) {
        return {
          success: true, // Already unset
          filePath: configFile,
          previousValue: undefined,
          newValue: undefined,
        };
      }

      // Create backup if requested (only if file exists)
      let backupPath: string | undefined;
      if (this.options.createBackup && (await this.fs.exists(configFile))) {
        const backupResult = await this.createBackup(configFile);
        if (!backupResult.success) {
          return {
            success: false,
            filePath: configFile,
            error: `Backup failed: ${backupResult.error}`,
          };
        }
        backupPath = backupResult.backupPath;
      }

      // Remove the value
      this.unsetNestedValue(currentConfig, keyPath);

      // Validate configuration if requested
      if (this.options.validate) {
        const validationResult = ConfigSchema.safeParse(currentConfig);
        if (!validationResult.success) {
          // Restore from backup if validation fails
          if (backupPath) {
            await this.restoreFromBackup(configFile, backupPath);
          }
          return {
            success: false,
            filePath: configFile,
            backupPath,
            error: `Validation failed: ${validationResult.error.message}`,
          };
        }
      }

      // Write updated configuration
      await this.writeConfigFile(configFile, currentConfig);

      log.debug(`Config value unset: ${keyPath}`);

      return {
        success: true,
        filePath: configFile,
        backupPath,
        previousValue,
        newValue: undefined,
      };
    } catch (error) {
      return {
        success: false,
        filePath: this.getConfigFilePath(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create a backup of the configuration file
   */
  private async createBackup(configFile: string): Promise<ConfigBackupResult> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${configFile}.backup.${timestamp}`;

      await this.fs.copyFile(configFile, backupPath);

      return {
        success: true,
        originalPath: configFile,
        backupPath,
      };
    } catch (error) {
      return {
        success: false,
        originalPath: configFile,
        backupPath: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Restore configuration from backup
   */
  private async restoreFromBackup(configFile: string, backupPath: string): Promise<void> {
    try {
      await this.fs.copyFile(backupPath, configFile);
      log.debug(`Configuration restored from backup: ${backupPath}`);
    } catch (error) {
      log.error(`Failed to restore from backup: ${error}`);
    }
  }

  /**
   * Ensure configuration directory exists
   */
  private async ensureConfigDir(): Promise<void> {
    if (!(await this.fs.exists(this.configDir))) {
      await this.fs.mkdir(this.configDir, { recursive: true });
    }
  }

  /**
   * Find existing configuration file
   */
  private async findConfigFile(): Promise<string | null> {
    for (const configFile of this.userConfigFiles) {
      const filePath = join(this.configDir, configFile);
      if (await this.fs.exists(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  /**
   * Find existing configuration file or create a new one
   */
  private async findOrCreateConfigFile(): Promise<string> {
    const existing = await this.findConfigFile();
    if (existing) {
      return existing;
    }

    // Create new config file with preferred format
    const fileName = this.options.format === "json" ? "config.json" : "config.yaml";
    return join(this.configDir, fileName);
  }

  /**
   * Get the default configuration file path
   */
  private getConfigFilePath(): string {
    const fileName = this.options.format === "json" ? "config.json" : "config.yaml";
    return join(this.configDir, fileName);
  }

  /**
   * Load configuration from file
   */
  private async loadConfigFile(filePath: string): Promise<Record<string, unknown>> {
    if (!(await this.fs.exists(filePath))) {
      return {};
    }

    try {
      const content = await this.fs.readFile(filePath, "utf8");
      const extension = filePath.split(".").pop()?.toLowerCase();

      switch (extension) {
        case "json":
          return JSON.parse(content) as Record<string, unknown>;
        case "yaml":
        case "yml":
          return (parse(content) as Record<string, unknown>) || {};
        default:
          throw new Error(`Unsupported file format: ${extension}`);
      }
    } catch (error) {
      throw new Error(`Failed to load config file ${filePath}: ${error}`);
    }
  }

  /**
   * Write configuration to file
   */
  private async writeConfigFile(filePath: string, config: Record<string, unknown>): Promise<void> {
    const extension = filePath.split(".").pop()?.toLowerCase();
    let content: string;

    switch (extension) {
      case "json":
        content = JSON.stringify(config, null, 2);
        break;
      case "yaml":
      case "yml":
        content = `# Minsky User Configuration
# This file contains your personal configuration settings
# It is stored in your user profile and not shared with others

${stringify(config, { indent: 2 })}`;
        break;
      default:
        throw new Error(`Unsupported file format: ${extension}`);
    }

    await this.fs.writeFile(filePath, content);
  }

  /**
   * Get nested value from object using dot notation
   * Dynamic path traversal requires index access on unknown-typed nested objects
   */
  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    return path.split(".").reduce<unknown>((current, key) => {
      if (current !== null && typeof current === "object") {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
  }

  /**
   * Set nested value in object using dot notation
   * Dynamic path traversal requires index access on unknown-typed nested objects
   */
  private setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    const lastKey = keys.pop();
    if (!lastKey) {
      throw new Error(`Invalid config path: "${path}"`);
    }

    let current: Record<string, unknown> = obj;
    for (const key of keys) {
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[lastKey] = value;
  }

  /**
   * Unset nested value in object using dot notation
   * Dynamic path traversal requires index access on unknown-typed nested objects
   */
  private unsetNestedValue(obj: Record<string, unknown>, path: string): void {
    const keys = path.split(".");
    const lastKey = keys.pop();
    if (!lastKey) {
      throw new Error(`Invalid config path: "${path}"`);
    }

    let current: Record<string, unknown> = obj;
    for (const key of keys) {
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        return; // Path doesn't exist
      }
      current = current[key] as Record<string, unknown>;
    }

    delete current[lastKey];

    // Clean up empty parent objects
    this.cleanupEmptyObjects(obj, keys);
  }

  /**
   * Remove empty parent objects after unsetting a value
   * Dynamic path traversal requires index access on unknown-typed nested objects
   */
  private cleanupEmptyObjects(obj: Record<string, unknown>, keys: string[]): void {
    if (keys.length === 0) return;

    let current: Record<string, unknown> = obj;
    const pathToCheck = [...keys];

    for (let i = 0; i < pathToCheck.length - 1; i++) {
      current = current[pathToCheck[i]!] as Record<string, unknown>;
    }

    const lastKey = pathToCheck[pathToCheck.length - 1]!;
    if (
      current[lastKey] &&
      typeof current[lastKey] === "object" &&
      Object.keys(current[lastKey] as Record<string, unknown>).length === 0
    ) {
      delete current[lastKey];
      // Recursively clean up parent
      this.cleanupEmptyObjects(obj, keys.slice(0, -1));
    }
  }
}

/**
 * Create a configuration writer instance
 */
export function createConfigWriter(
  options?: ConfigWriterOptions,
  deps?: { fs?: FsLike; getUserConfigDir?: () => string; userConfigFiles?: readonly string[] }
): ConfigWriter {
  return new ConfigWriter(options, deps);
}
