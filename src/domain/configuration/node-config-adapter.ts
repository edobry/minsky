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
    const resolved: ResolvedConfig = {
      backend: (config as any).get("backend"),
      backendConfig: (config as any).get("backendConfig"),
      detectionRules: (config as any).get("detectionRules"),
      sessiondb: (config as any).get("sessiondb"),
      ai: (config as any).has("ai") ? (config as any).get("ai") : undefined as any,
    };

    // Create mock sources for backward compatibility
    // In the future, we can remove this and just return the resolved config
    const sources: ConfigurationSources = {
      cliFlags: {},
      environment: this.getEnvironmentOverrides(),
      globalUser: null as any, // Will be handled by node-config's local.yaml
      repository: null as any, // TODO: Handle .minsky/config.yaml separately
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
    const overrides: Partial<ResolvedConfig> = {};

    // These will be handled by custom-environment-variables.yaml in node-config
    // but we maintain this for compatibility during migration
    if ((process.env as any).MINSKY_BACKEND) {
      (overrides as any).backend = (process.env as any).MINSKY_BACKEND as any;
    }

    return overrides;
  }

  /**
   * Get default configuration for backward compatibility
   */
  private getDefaultConfig(): Partial<ResolvedConfig> {
    return {
      backend: "json-file",
      backendConfig: {},
      detectionRules: [
        { condition: "tasks_md_exists", backend: "markdown" },
        { condition: "json_file_exists", backend: "json-file" },
        { condition: "always", backend: "json-file" },
      ],
      sessiondb: {
        backend: "json",
        baseDir: undefined as any,
        dbPath: undefined as any,
        connectionString: undefined as any,
      },
    };
  }
}
