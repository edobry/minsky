/**
 * Configuration loader for Minsky
 * 
 * Implements the 5-level configuration hierarchy:
 * 1. CLI flags (highest priority)
 * 2. Environment variables
 * 3. Global user config (~/.config/minsky/config.yaml)
 * 4. Repository config (.minsky/config.yaml)
 * 5. Built-in defaults (lowest priority)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { homedir } from "os";
import {
  ConfigurationLoadResult,
  ConfigurationSources,
  ResolvedConfig,
  RepositoryConfig,
  GlobalUserConfig,
  BackendConfig,
  CredentialConfig,
  DetectionRule,
  DEFAULT_CONFIG,
  CONFIG_PATHS,
  ENV_VARS
} from "./types";

export class ConfigurationLoader {
  /**
   * Load configuration from all sources with proper precedence
   */
  async loadConfiguration(
    workingDir: string,
    cliFlags: Partial<ResolvedConfig> = {}
  ): Promise<ConfigurationLoadResult> {
    // Load from all sources
    const sources: ConfigurationSources = {
      cliFlags,
      environment: this.loadEnvironmentConfig(),
      globalUser: await this.loadGlobalUserConfig(),
      repository: await this.loadRepositoryConfig(workingDir),
      defaults: DEFAULT_CONFIG
    };

    // Merge with precedence: CLI > env > global user > repo > defaults
    const resolved = this.mergeConfigurations(sources);

    return {
      resolved,
      sources
    };
  }

  /**
   * Load environment variable overrides
   */
  private loadEnvironmentConfig(): Partial<ResolvedConfig> {
    const config: Partial<ResolvedConfig> = {};

    // Backend override
    if (process.env[ENV_VARS.BACKEND]) {
      config.backend = process.env[ENV_VARS.BACKEND];
    }

    // GitHub token for credentials
    if (process.env[ENV_VARS.GITHUB_TOKEN]) {
      config.credentials = {
        github: {
          token: process.env[ENV_VARS.GITHUB_TOKEN],
          source: "environment"
        }
      };
    }

    return config;
  }

  /**
   * Load global user configuration from XDG directory
   */
  private async loadGlobalUserConfig(): Promise<GlobalUserConfig | null> {
    const configPath = this.expandTilde(CONFIG_PATHS.GLOBAL_USER);
    
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" });
      return parseYaml(content) as GlobalUserConfig;
    } catch (error) {
      // Use a simple fallback for logging since proper logging infrastructure may not be available yet
      console.error(`Failed to load global user config from ${configPath}:`, error);
      return null;
    }
  }

  /**
   * Load repository configuration
   */
  private async loadRepositoryConfig(workingDir: string): Promise<RepositoryConfig | null> {
    const configPath = join(workingDir, CONFIG_PATHS.REPOSITORY);
    
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" });
      return parseYaml(content) as RepositoryConfig;
    } catch (error) {
      // Silently fail - configuration loading should be resilient
      return null;
    }
  }

  /**
   * Merge configurations with proper precedence
   */
  private mergeConfigurations(sources: ConfigurationSources): ResolvedConfig {
    const { cliFlags, environment, globalUser, repository, defaults } = sources;

    // Start with defaults
    const resolved: ResolvedConfig = {
      backend: defaults.backend || "json-file",
      backendConfig: { ...defaults.backendConfig },
      credentials: { ...defaults.credentials },
      detectionRules: [...(defaults.detectionRules || [])]
    };

    // Apply repository config
    if (repository) {
      if (repository.backends?.default) {
        resolved.backend = repository.backends.default;
      }

      // Merge backend-specific configs
      if (repository.backends) {
        resolved.backendConfig = this.mergeBackendConfig(
          resolved.backendConfig,
          repository.backends
        );
      }

      // Use repository detection rules if available
      if (repository.repository?.detection_rules) {
        resolved.detectionRules = repository.repository.detection_rules;
      }
    }

    // Apply global user config
    if (globalUser?.credentials) {
      resolved.credentials = this.mergeCredentials(
        resolved.credentials,
        globalUser.credentials
      );
    }

    // Apply environment overrides
    if (environment.backend) {
      resolved.backend = environment.backend;
    }
    if (environment.credentials) {
      resolved.credentials = this.mergeCredentials(
        resolved.credentials,
        environment.credentials
      );
    }

    // Apply CLI flags (highest priority)
    if (cliFlags.backend) {
      resolved.backend = cliFlags.backend;
    }
    if (cliFlags.backendConfig) {
      resolved.backendConfig = { ...resolved.backendConfig, ...cliFlags.backendConfig };
    }
    if (cliFlags.credentials) {
      resolved.credentials = this.mergeCredentials(
        resolved.credentials,
        cliFlags.credentials
      );
    }

    return resolved;
  }

  /**
   * Merge backend configurations
   */
  private mergeBackendConfig(
    existing: BackendConfig,
    repositoryBackends: RepositoryConfig["backends"]
  ): BackendConfig {
    const merged = { ...existing };

    if (repositoryBackends?.["github-issues"]) {
      merged["github-issues"] = repositoryBackends["github-issues"];
    }

    return merged;
  }

  /**
   * Merge credential configurations
   */
  private mergeCredentials(
    existing: CredentialConfig,
    newCredentials: GlobalUserConfig["credentials"] | CredentialConfig
  ): CredentialConfig {
    const merged = { ...existing };

    if (newCredentials?.github) {
      merged.github = { ...merged.github, ...newCredentials.github };
    }

    return merged;
  }

  /**
   * Expand tilde in file paths
   */
  private expandTilde(filePath: string): string {
    if (filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(2));
    }
    return filePath;
  }
} 
