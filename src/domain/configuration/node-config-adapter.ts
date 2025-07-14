/**
 * Node-config adapter for Minsky configuration system
 *
 * Provides backward compatibility with the existing ConfigurationService interface
 * while using node-config internally for configuration management.
 */

import config from "config";
import {
  ConfigurationService,
  ConfigurationLoadResult,
  ResolvedConfig,
  ConfigurationSources,
  ValidationResult,
  RepositoryConfig,
  GlobalUserConfig,
} from "./types";

export class NodeConfigAdapter implements ConfigurationService {
  /**
   * Load configuration using node-config
   * Maintains compatibility with existing interface
   */
  async loadConfiguration(_workingDir: string): Promise<ConfigurationLoadResult> {
    // Use node-config to get the resolved configuration
    const sessiondbConfig = (config as any).get("sessiondb");
    
    // Transform sessiondb configuration to match expected interface
    const sessiondb = {
      backend: sessiondbConfig?.backend || "json",
      baseDir: sessiondbConfig?.baseDir || null,
      dbPath: sessiondbConfig?.sqlite?.path || sessiondbConfig?.dbPath || null,
      connectionString: sessiondbConfig?.postgres?.connectionString || sessiondbConfig?.connectionString || null,
    };

    const resolved: ResolvedConfig = {
      backend: (config as any).get("backend"),
      backendConfig: (config as any).get("backendConfig"),
      detectionRules: (config as any).get("detectionRules"),
      sessiondb,
      ai: (config as any).has("ai") ? (config as any).get("ai") : undefined,
    };

    // Create mock sources for backward compatibility
    // In the future, we can remove this and just return the resolved config
    const sources: ConfigurationSources = {
      configOverrides: {},
      environment: this.getEnvironmentOverrides(),
      globalUser: null, // Will be handled by node-config's local.yaml
      repository: null, // TODO: Handle .minsky/config.yaml separately
      defaults: this.getDefaultConfig(),
    };

    return {
      resolved,
      sources,
    };
  }

  /**
   * Validate repository configuration
   * TODO: Implement using node-config's validation features
   */
  validateRepositoryConfig(config: RepositoryConfig): ValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Validate global user configuration
   * TODO: Implement using node-config's validation features
   */
  validateGlobalUserConfig(config: GlobalUserConfig): ValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Get environment overrides for backward compatibility
   */
  private getEnvironmentOverrides(): Partial<ResolvedConfig> {
    // This would normally extract environment variables that override config
    // For now, return empty object as node-config handles this automatically
    return {};
  }

  /**
   * Get default configuration for backward compatibility
   */
  private getDefaultConfig(): Partial<ResolvedConfig> {
    // Extract default values from node-config
    return {
      backend: (config as any).get("backend") || "json-file",
      sessiondb: {
        backend: (config as any).get("sessiondb.backend") || "json",
        baseDir: (config as any).get("sessiondb.baseDir") as string | undefined,
        dbPath: (config as any).get("sessiondb.dbPath") as string | undefined,
        connectionString: (config as any).get("sessiondb.connectionString") as string | undefined,
      },
      ai: (config as any).has("ai") ? (config as any).get("ai") : undefined,
    };
  }
}
