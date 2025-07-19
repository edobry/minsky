/**
 * Configuration Validation Utilities
 * 
 * Additional validation helpers and utilities for configuration validation
 * beyond what's provided by the Zod schemas.
 */

import type { Configuration, PartialConfiguration, ConfigurationValidationResult } from "./schemas";
import { configurationSchema } from "./schemas";
import type { ConfigurationLoadResult } from "./loader";

/**
 * Validation severity levels
 */
export enum ValidationSeverity {
  ERROR = "error",
  WARNING = "warning",
  INFO = "info",
}

/**
 * Enhanced validation issue
 */
export interface ValidationIssue {
  path: string;
  message: string;
  severity: ValidationSeverity;
  code?: string;
  source?: string;
  suggestion?: string;
}

/**
 * Enhanced validation result
 */
export interface EnhancedValidationResult {
  valid: boolean;
  config?: Configuration;
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
}

/**
 * Validation context for cross-field validation
 */
export interface ValidationContext {
  environment: string;
  workingDirectory: string;
  sourceMetadata: Record<string, any>;
}

/**
 * Enhanced configuration validator
 */
export class ConfigurationValidator {
  private readonly context: ValidationContext;

  constructor(context: Partial<ValidationContext> = {}) {
    this.context = {
      environment: process.env.NODE_ENV || "development",
      workingDirectory: process.cwd(),
      sourceMetadata: {},
      ...context,
    };
  }

  /**
   * Validate configuration with enhanced error reporting
   */
  validate(config: PartialConfiguration): EnhancedValidationResult {
    const issues: ValidationIssue[] = [];
    
    // Run Zod validation first
    const zodResult = configurationSchema.safeParse(config);
    
    if (!zodResult.success) {
      // Convert Zod errors to enhanced issues
      for (const error of zodResult.error.issues) {
        issues.push({
          path: error.path.join("."),
          message: error.message,
          severity: ValidationSeverity.ERROR,
          code: error.code,
        });
      }
    }

    // Run custom validation rules
    if (zodResult.success) {
      this.runCustomValidations(zodResult.data, issues);
    }

    // Build result
    const summary = this.summarizeIssues(issues);
    
    return {
      valid: summary.errors === 0,
      config: zodResult.success ? zodResult.data : undefined,
      issues,
      summary,
    };
  }

  /**
   * Validate a configuration load result
   */
  validateLoadResult(loadResult: ConfigurationLoadResult): EnhancedValidationResult {
    const issues: ValidationIssue[] = [];
    
    // Check source loading issues
    for (const sourceResult of loadResult.sources) {
      if (!sourceResult.success && sourceResult.source.required) {
        issues.push({
          path: `source.${sourceResult.source.name}`,
          message: `Required configuration source failed to load: ${sourceResult.error?.message || "Unknown error"}`,
          severity: ValidationSeverity.ERROR,
          source: sourceResult.source.name,
        });
      } else if (!sourceResult.success) {
        issues.push({
          path: `source.${sourceResult.source.name}`,
          message: `Optional configuration source failed to load: ${sourceResult.error?.message || "Unknown error"}`,
          severity: ValidationSeverity.WARNING,
          source: sourceResult.source.name,
        });
      }
    }

    // Check for configuration conflicts
    this.checkConfigurationConflicts(loadResult, issues);

    // Run basic validation on the final config
    const configValidation = this.validate(loadResult.config);
    issues.push(...configValidation.issues);

    const summary = this.summarizeIssues(issues);
    
    return {
      valid: summary.errors === 0,
      config: loadResult.config,
      issues,
      summary,
    };
  }

  /**
   * Run custom validation rules
   */
  private runCustomValidations(config: Configuration, issues: ValidationIssue[]): void {
    // Validate GitHub configuration
    this.validateGitHubConfig(config, issues);
    
    // Validate session database configuration
    this.validateSessionDbConfig(config, issues);
    
    // Validate AI provider configuration
    this.validateAIConfig(config, issues);
    
    // Validate environment-specific configurations
    this.validateEnvironmentConfig(config, issues);
  }

  /**
   * Validate GitHub configuration
   */
  private validateGitHubConfig(config: Configuration, issues: ValidationIssue[]): void {
    const github = config.github;
    
    // Check if both token and tokenFile are specified
    if (github.token && github.tokenFile) {
      issues.push({
        path: "github",
        message: "Both 'token' and 'tokenFile' are specified. 'token' will take precedence.",
        severity: ValidationSeverity.WARNING,
        suggestion: "Use either 'token' OR 'tokenFile', not both",
      });
    }
    
    // Check if organization and repository are both specified when needed
    if (config.backend === "github-issues") {
      const backendConfig = config.backendConfig["github-issues"];
      if (!backendConfig?.owner || !backendConfig?.repo) {
        issues.push({
          path: "backendConfig.github-issues",
          message: "GitHub Issues backend requires both 'owner' and 'repo' to be configured",
          severity: ValidationSeverity.ERROR,
          suggestion: "Add 'owner' and 'repo' to backendConfig.github-issues",
        });
      }
    }
  }

  /**
   * Validate session database configuration
   */
  private validateSessionDbConfig(config: Configuration, issues: ValidationIssue[]): void {
    const sessiondb = config.sessiondb;
    
    // Check backend-specific requirements
    switch (sessiondb.backend) {
    case "postgres":
      if (!sessiondb.postgres?.connectionString) {
        issues.push({
          path: "sessiondb.postgres.connectionString",
          message: "PostgreSQL backend requires a connection string",
          severity: ValidationSeverity.ERROR,
          suggestion: "Add connectionString to sessiondb.postgres configuration",
        });
      }
      break;
        
    case "sqlite":
      // SQLite is more flexible, but warn about default behavior
      if (!sessiondb.sqlite?.path && !sessiondb.sqlite?.baseDir) {
        issues.push({
          path: "sessiondb.sqlite",
          message: "SQLite backend will use default database location",
          severity: ValidationSeverity.INFO,
          suggestion: "Consider specifying 'path' or 'baseDir' for explicit control",
        });
      }
      break;
    }
  }

  /**
   * Validate AI provider configuration
   */
  private validateAIConfig(config: Configuration, issues: ValidationIssue[]): void {
    const ai = config.ai;
    
    // Check if default provider is configured
    if (ai.defaultProvider) {
      const providerConfig = ai.providers[ai.defaultProvider];
      if (!providerConfig) {
        issues.push({
          path: `ai.providers.${ai.defaultProvider}`,
          message: `Default AI provider '${ai.defaultProvider}' is not configured`,
          severity: ValidationSeverity.ERROR,
          suggestion: `Add configuration for ai.providers.${ai.defaultProvider}`,
        });
      } else if (!providerConfig.apiKey && !providerConfig.apiKeyFile) {
        issues.push({
          path: `ai.providers.${ai.defaultProvider}`,
          message: `Default AI provider '${ai.defaultProvider}' has no API key configured`,
          severity: ValidationSeverity.WARNING,
          suggestion: "Add 'apiKey' or 'apiKeyFile' to the provider configuration",
        });
      }
    }
    
    // Check for conflicting API key configurations
    for (const [providerName, providerConfig] of Object.entries(ai.providers)) {
      if (providerConfig?.apiKey && providerConfig?.apiKeyFile) {
        issues.push({
          path: `ai.providers.${providerName}`,
          message: `Provider '${providerName}' has both 'apiKey' and 'apiKeyFile'. 'apiKey' will take precedence.`,
          severity: ValidationSeverity.WARNING,
          suggestion: "Use either 'apiKey' OR 'apiKeyFile', not both",
        });
      }
    }
  }

  /**
   * Validate environment-specific configurations
   */
  private validateEnvironmentConfig(config: Configuration, issues: ValidationIssue[]): void {
    // Warn about potentially unsafe configurations in production
    if (this.context.environment === "production") {
      if (config.logger.level === "debug") {
        issues.push({
          path: "logger.level",
          message: "Debug logging is enabled in production environment",
          severity: ValidationSeverity.WARNING,
          suggestion: "Consider using 'info' or 'warn' level in production",
        });
      }
      
      if (config.logger.enableAgentLogs) {
        issues.push({
          path: "logger.enableAgentLogs",
          message: "Agent logs are enabled in production environment",
          severity: ValidationSeverity.WARNING,
          suggestion: "Consider disabling agent logs in production for performance",
        });
      }
    }
  }

  /**
   * Check for configuration conflicts across sources
   */
  private checkConfigurationConflicts(loadResult: ConfigurationLoadResult, issues: ValidationIssue[]): void {
    // Check for values that were overridden multiple times
    const overrideCount: Record<string, number> = {};
    
    for (const [path, valueInfo] of Object.entries(loadResult.effectiveValues)) {
      // Count how many sources provided this value
      const sourcesWithValue = loadResult.sources
        .filter(s => s.success && this.hasValueAtPath(s.config, path))
        .length;
        
      if (sourcesWithValue > 1) {
        overrideCount[path] = sourcesWithValue;
      }
    }
    
    // Report heavily overridden values as info
    for (const [path, count] of Object.entries(overrideCount)) {
      if (count >= 3) {
        const finalSource = loadResult.effectiveValues[path]?.source;
        issues.push({
          path,
          message: `Configuration value overridden ${count} times, final value from '${finalSource}'`,
          severity: ValidationSeverity.INFO,
          suggestion: "Review configuration sources for potential conflicts",
        });
      }
    }
  }

  /**
   * Check if a configuration object has a value at the given path
   */
  private hasValueAtPath(config: any, path: string): boolean {
    const parts = path.split(".");
    let current = config;
    
    for (const part of parts) {
      if (current === null || current === undefined || !(part in current)) {
        return false;
      }
      current = current[part];
    }
    
    return current !== undefined;
  }

  /**
   * Summarize validation issues by severity
   */
  private summarizeIssues(issues: ValidationIssue[]): { errors: number; warnings: number; infos: number } {
    return issues.reduce(
      (summary, issue) => {
        switch (issue.severity) {
        case ValidationSeverity.ERROR:
          summary.errors++;
          break;
        case ValidationSeverity.WARNING:
          summary.warnings++;
          break;
        case ValidationSeverity.INFO:
          summary.infos++;
          break;
        }
        return summary;
      },
      { errors: 0, warnings: 0, infos: 0 }
    );
  }
}

/**
 * Quick validation function
 */
export function validateConfiguration(
  config: PartialConfiguration,
  context?: Partial<ValidationContext>
): EnhancedValidationResult {
  const validator = new ConfigurationValidator(context);
  return validator.validate(config);
}

/**
 * Quick validation for load results
 */
export function validateLoadResult(
  loadResult: ConfigurationLoadResult,
  context?: Partial<ValidationContext>
): EnhancedValidationResult {
  const validator = new ConfigurationValidator(context);
  return validator.validateLoadResult(loadResult);
} 
