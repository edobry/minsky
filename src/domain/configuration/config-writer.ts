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
export interface FsLike {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string | Buffer;
  writeFileSync: (path: string, data: string, encoding?: string) => void;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  copyFileSync: (src: string, dest: string) => void;
}

export class ConfigWriter {
  private readonly options: Required<ConfigWriterOptions>;
  private readonly configDir: string;
  private readonly fsImpl: FsLike = fs;

  constructor(options: ConfigWriterOptions = {}, fsOverride?: FsLike) {
    this.options = {
      createBackup: true,
      format: "yaml",
      createDir: true,
      validate: true,
      ...options,
    };
    this.configDir = getUserConfigDir();
    if (fsOverride) this.fsImpl = fsOverride;
  }

  /**
   * Set a configuration value by key path
   */
  async setConfigValue(keyPath: string, value: any): Promise<ConfigModificationResult> {
    try {
      if (this.options.createDir) {
        this.ensureConfigDir();
      }

      const configFile = this.findOrCreateConfigFile();
      let currentConfig: any;
      try {
        currentConfig = this.loadConfigFile(configFile);
      } catch (e: any) {
        return {
          success: false,
          filePath: configFile,
          error: e?.message || String(e),
        };
      }

      // STEP 1: Create backup if configured
      let backupPath: string | undefined;
      if (this.options.createBackup) {
        const backupResult = self.safeCreateBackup(this, configFile);
        if (!backupResult.success) {
          return {
            success: false,
            filePath: configFile,
            error: `Backup failed: ${backupResult.error}`,
          };
        }
        backupPath = backupResult.backupPath;
      }

      const previousValue = this.getNestedValue(currentConfig, keyPath);
      this.setNestedValue(currentConfig, keyPath, value);

      if (this.options.validate) {
        const validationResult = ConfigSchema.safeParse(currentConfig);
        if (!validationResult.success) {
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

      // STEP 2: Persist to disk, with restore on failure (symmetric with unset)
      try {
        this.writeConfigFile(configFile, currentConfig);
      } catch (writeError: any) {
        if (backupPath) {
          this.restoreFromBackup(configFile, backupPath);
        }
        return {
          success: false,
          filePath: configFile,
          backupPath,
          error: writeError?.message || String(writeError),
        };
      }

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
      // Resolve config file or initialize an empty one if allowed
      const existing = this.findConfigFile();
      const configFile = existing || this.getConfigFilePath();

      if (!existing) {
        console.log("unset: no-existing-config");
        return {
          success: false,
          filePath: configFile,
          error: "No configuration file found to modify",
        };
      }

      log.debug(`unset using file: ${configFile}`);

      const currentConfig = this.loadConfigFile(configFile);

      const previousValue = this.getNestedValue(currentConfig, keyPath);
      if (previousValue === undefined) {
        return {
          success: true,
          filePath: configFile,
          previousValue: undefined,
          newValue: undefined,
        };
      }

      let backupPath: string | undefined;
      if (this.options.createBackup) {
        const backupResult = self.safeCreateBackup(this, configFile);
        if (!backupResult.success) {
          return {
            success: false,
            filePath: configFile,
            error: `Backup failed: ${backupResult.error}`,
          };
        }
        backupPath = backupResult.backupPath;
      }

      // STEP 2: Remove value from config object
      this.unsetNestedValue(currentConfig, keyPath);

      if (this.options.validate) {
        const validationResult = ConfigSchema.safeParse(currentConfig);
        if (!validationResult.success) {
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

      // STEP 3: Persist to disk, with restore on failure
      try {
        this.writeConfigFile(configFile, currentConfig);
      } catch (writeError: any) {
        if (backupPath) {
          this.restoreFromBackup(configFile, backupPath);
        }
        return {
          success: false,
          filePath: configFile,
          backupPath,
          error: writeError?.message || String(writeError),
        };
      }

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

      this.fsImpl.copyFileSync(configFile, backupPath);

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
      this.fsImpl.copyFileSync(backupPath, configFile);
      log.debug(`Configuration restored from backup: ${backupPath}`);
    } catch (error) {
      log.error(`Failed to restore from backup: ${error}`);
    }
  }

  /**
   * Ensure configuration directory exists
   */
  private ensureConfigDir(): void {
    if (!this.fsImpl.existsSync(this.configDir)) {
      this.fsImpl.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Find existing configuration file
   */
  private findConfigFile(): string | null {
    for (const configFile of userConfigFiles) {
      const filePath = path.join(this.configDir, configFile);
      if (this.fsImpl.existsSync(filePath)) {
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
    if (!this.fsImpl.existsSync(filePath)) {
      return {};
    }

    try {
      const content = this.fsImpl.readFileSync(filePath, "utf8") as string;
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
        content = `# Minsky User Configuration\n# This file contains your personal configuration settings\n# It is stored in your user profile and not shared with others\n\n${yaml.stringify(config, { indent: 2 })}`;
        break;
      default:
        throw new Error(`Unsupported file format: ${extension}`);
    }

    this.fsImpl.writeFileSync(filePath, content, "utf8");
  }

  private getNestedValue(obj: any, pathStr: string): any {
    return pathStr.split(".").reduce((current, key) => {
      return current?.[key];
    }, obj);
  }

  private setNestedValue(obj: any, pathStr: string, value: any): void {
    const keys = pathStr.split(".");
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

  private unsetNestedValue(obj: any, pathStr: string): void {
    const keys = pathStr.split(".");
    const lastKey = keys.pop()!;

    let current = obj;
    for (const key of keys) {
      if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
        return;
      }
      current = current[key];
    }

    delete current[lastKey];

    this.cleanupEmptyObjects(obj, keys);
  }

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
      this.cleanupEmptyObjects(obj, keys.slice(0, -1));
    }
  }
}

/**
 * Helper namespace to avoid repeating try/catch in backup calls
 */
namespace self {
  export function safeCreateBackup(writer: ConfigWriter, configFile: string): ConfigBackupResult {
    try {
      return (writer as any).createBackup(configFile);
    } catch (err) {
      return {
        success: false,
        originalPath: configFile,
        backupPath: "",
        error: String(err),
      } as ConfigBackupResult;
    }
  }
}

/**
 * Create a configuration writer instance
 */
export function createConfigWriter(options?: ConfigWriterOptions): ConfigWriter {
  return new ConfigWriter(options);
}
