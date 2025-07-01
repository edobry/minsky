/**
 * Configuration Validation Service
 * 
 * Handles configuration validation logic that was previously embedded in the configuration system.
 * This is domain-specific logic that should be preserved during the surgical decoupling.
 */

import type { SessionDbConfig } from "./types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class ConfigurationValidator {
  /**
   * Validate SessionDB configuration
   */
  static validateSessionDbConfig(config: SessionDbConfig): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    // Validate backend type
    const validBackends = ["json", "sqlite", "postgres"];
    if (!validBackends.includes(config.backend)) {
      result.valid = false;
      result.errors.push(`Invalid backend: ${config.backend}. Must be one of: ${validBackends.join(", ")}`);
    }

    // Backend-specific validation
    switch (config.backend) {
    case "sqlite":
      if (!config.dbPath) {
        result.valid = false;
        result.errors.push("SQLite backend requires dbPath to be specified");
      }
      break;

    case "postgres":
      if (!config.connectionString) {
        result.valid = false;
        result.errors.push("PostgreSQL backend requires connectionString to be specified");
      } else if (!this.isValidPostgresUrl(config.connectionString)) {
        result.valid = false;
        result.errors.push("Invalid PostgreSQL connection string format");
      }
      break;

    case "json":
      // JSON backend can work with or without explicit paths
      if (config.dbPath && !config.dbPath.endsWith(".json")) {
        result.warnings.push("JSON backend dbPath should end with .json extension");
      }
      break;
    }

    // Validate base directory
    if (config.baseDir && !config.baseDir.trim()) {
      result.warnings.push("baseDir is empty, using default");
    }

    return result;
  }

  /**
   * Validate PostgreSQL connection string format
   */
  private static isValidPostgresUrl(connectionString: string): boolean {
    try {
      // Basic validation for PostgreSQL URL format
      const url = new URL(connectionString);
      return url.protocol === "postgresql:" || url.protocol === "postgres:";
    } catch {
      return false;
    }
  }

  /**
   * Validate backend configuration
   */
  static validateBackend(backend: string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    const validBackends = ["json-file", "markdown", "github"];
    if (!validBackends.includes(backend)) {
      result.valid = false;
      result.errors.push(`Invalid backend: ${backend}. Must be one of: ${validBackends.join(", ")}`);
    }

    return result;
  }

  /**
   * Validate credential configuration
   */
  static validateCredentials(credentials: any): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    if (credentials?.github) {
      if (!credentials.github.token && credentials.github.source !== "environment") {
        result.warnings.push("GitHub credentials configured but no token provided");
      }
    }

    return result;
  }
} 
