/**
 * Configuration Writer
 *
 * Handles writing configuration changes to user configuration files with
 * backup functionality and validation.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getUserConfigDir, userConfigFiles } from "./sources/user";
import { ConfigSchema } from "./config-schemas";
import { log } from "../../utils/logger";

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
}

/**
 * Configuration modification result
 */
export interface ConfigModificationResult {
  success: boolean;
  filePath: string;
  backupPath?: string;
  previousValue?: any;
  newValue?: any;
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

  constructor(options: ConfigWriterOptions = {}) {
    this.options = {
      createBackup: true,
      format: "yaml",
      createDir: true,
      validate: true,
      ...options,
    };
    this.configDir = getUserConfigDir();
  }

  /**
   * Set a configuration value by key path
   */
  async setConfigValue(keyPath: string, value: any): Promise<ConfigModificationResult> {
    try {
      // Ensure config directory exists
      if (this.options.createDir) {
        this.ensureConfigDir();
      }

      // Find or create config file
      const configFile = this.findOrCreateConfigFile();

      // Load current configuration
      const currentConfig = this.loadConfigFile(configFile);

      // Create backup if requested
      let backupPath: string | undefined;
      if (this.options.createBackup) {
        const backupResult = this.createBackup(configFile);
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
            this.restoreFromBackup(configFile, backupPath);
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
      this.writeConfigFile(configFile, currentConfig);

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
      const configFile = this.findConfigFile();
      if (!configFile) {
        return {
          success: false,
          filePath: this.getConfigFilePath(),
          error: "No configuration file found to modify",
        };
      }

      // Load current configuration
      const currentConfig = this.loadConfigFile(configFile);

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

      // Create backup if requested
      let backupPath: string | undefined;
      if (this.options.createBackup) {
        const backupResult = this.createBackup(configFile);
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
            this.restoreFromBackup(configFile, backupPath);
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
      this.writeConfigFile(configFile, currentConfig);

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
  private createBackup(configFile: string): ConfigBackupResult {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${configFile}.backup.${timestamp}`;

      fs.copyFileSync(configFile, backupPath);

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
  private restoreFromBackup(configFile: string, backupPath: string): void {
    try {
      fs.copyFileSync(backupPath, configFile);
      log.debug(`Configuration restored from backup: ${backupPath}`);
    } catch (error) {
      log.error(`Failed to restore from backup: ${error}`);
    }
  }

  /**
   * Ensure configuration directory exists
   */
  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Find existing configuration file
   */
  private findConfigFile(): string | null {
    for (const configFile of userConfigFiles) {
      const filePath = path.join(this.configDir, configFile);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  /**
   * Find existing configuration file or create a new one
   */
  private findOrCreateConfigFile(): string {
    const existing = this.findConfigFile();
    if (existing) {
      return existing;
    }

    // Create new config file with preferred format
    const fileName = this.options.format === "json" ? "config.json" : "config.yaml";
    return path.join(this.configDir, fileName);
  }

  /**
   * Get the default configuration file path
   */
  private getConfigFilePath(): string {
    const fileName = this.options.format === "json" ? "config.json" : "config.yaml";
    return path.join(this.configDir, fileName);
  }

  /**
   * Load configuration from file
   */
  private loadConfigFile(filePath: string): any {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const extension = filePath.split(".").pop()?.toLowerCase();

      switch (extension) {
        case "json":
          return JSON.parse(content);
        case "yaml":
        case "yml":
          return yaml.parse(content) || {};
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
  private writeConfigFile(filePath: string, config: any): void {
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

${yaml.stringify(config, { indent: 2 })}`;
        break;
      default:
        throw new Error(`Unsupported file format: ${extension}`);
    }

    fs.writeFileSync(filePath, content, "utf8");
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => {
      return current?.[key];
    }, obj);
  }

  /**
   * Set nested value in object using dot notation
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split(".");
    const lastKey = keys.pop()!;

    let current = obj;
    for (const key of keys) {
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        current[key] = {};
      }
      current = current[key];
    }

    current[lastKey] = value;
  }

  /**
   * Unset nested value in object using dot notation
   */
  private unsetNestedValue(obj: any, path: string): void {
    const keys = path.split(".");
    const lastKey = keys.pop()!;

    let current = obj;
    for (const key of keys) {
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        return; // Path doesn't exist
      }
      current = current[key];
    }

    delete current[lastKey];

    // Clean up empty parent objects
    this.cleanupEmptyObjects(obj, keys);
  }

  /**
   * Remove empty parent objects after unsetting a value
   */
  private cleanupEmptyObjects(obj: any, keys: string[]): void {
    if (keys.length === 0) return;

    let current = obj;
    const pathToCheck = [...keys];

    for (let i = 0; i < pathToCheck.length - 1; i++) {
      current = current[pathToCheck[i]];
    }

    const lastKey = pathToCheck[pathToCheck.length - 1];
    if (
      current[lastKey] &&
      typeof current[lastKey] === "object" &&
      Object.keys(current[lastKey]).length === 0
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
export function createConfigWriter(options?: ConfigWriterOptions): ConfigWriter {
  return new ConfigWriter(options);
}
