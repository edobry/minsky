/**
 * Configuration loader for Minsky
 *
 * Implements the 5-level configuration hierarchy:
 * 1. Configuration overrides (highest priority) - for runtime config injection
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
  SessionDbConfig,
  GitHubConfig,
  AIConfig,
  PostgresConfig,
  DEFAULT_CONFIG,
  CONFIG_PATHS,
  ENV_VARS,
} from "./types";

export class ConfigurationLoader {
  /**
   * Load configuration from all sources with proper precedence
   * 
   * @param workingDir - The working directory to load repository config from
   * @param configOverrides - High-priority configuration overrides (e.g., for testing or runtime injection)
   * @returns Promise resolving to the merged configuration and source information
   * 
   * @example
   * // Basic usage
   * const config = await loader.loadConfiguration('/path/to/repo');
   * 
   * @example
   * // With configuration overrides (useful for testing)
   * const testConfig = {
   *   sessiondb: { backend: "sqlite", dbPath: "/test/sessions.db" }
   * };
   * const config = await loader.loadConfiguration('/path/to/repo', testConfig);
   */
  async loadConfiguration(
    workingDir: string,
    configOverrides: Partial<ResolvedConfig> = {}
  ): Promise<ConfigurationLoadResult> {
    // Load from all sources
    const sources: ConfigurationSources = {
      configOverrides,
      environment: this.loadEnvironmentConfig(),
      globalUser: await this.loadGlobalUserConfig(),
      repository: await this.loadRepositoryConfig(workingDir),
      defaults: DEFAULT_CONFIG,
    };

    // Merge with precedence: config overrides > env > global user > repo > defaults
    const resolved = this.mergeConfigurations(sources);

    return {
      resolved,
      sources,
    };
  }

  /**
   * Load environment variable overrides
   * 
   * Automatically maps environment variables to config paths by converting
   * underscore-separated names to nested config structure.
   * E.g., GITHUB_TOKEN -> github.token, AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.api_key
   */
  private loadEnvironmentConfig(): Partial<ResolvedConfig> {
    const config: Partial<ResolvedConfig> = {};

    // Backend override (legacy)
    if ((process as any).env[ENV_VARS.BACKEND]) {
      (config as any).backend = (process as any).env[ENV_VARS.BACKEND] as any;
    }

    // Generic environment variable mapping
    for (const [key, value] of Object.entries(process.env)) {
      if (value && this.isConfigEnvironmentVariable(key)) {
        this.setConfigFromEnvironmentVariable(config, key, value);
      }
    }

    return config;
  }

  /**
   * Check if an environment variable should be mapped to config
   */
  private isConfigEnvironmentVariable(key: string): boolean {
    // Skip system and framework environment variables
    const systemPrefixes = ["PATH", "HOME", "USER", "SHELL", "NODE_", "npm_", "MINSKY_"];
    return !systemPrefixes.some(prefix => key.startsWith(prefix));
  }

  /**
   * Convert environment variable to config path and set value
   * E.g., GITHUB_TOKEN -> github.token, AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.api_key
   */
  private setConfigFromEnvironmentVariable(config: any, envKey: string, value: string): void {
    // Convert UPPER_CASE to lowercase.dotted.path with special handling for compound words
    let configPath = envKey.toLowerCase().split("_").join(".");
    
    // Handle specific compound words that should stay together
    configPath = configPath.replace(/\.api\.key$/, ".api_key");
    configPath = configPath.replace(/\.api\.key\.file$/, ".api_key_file");
    configPath = configPath.replace(/\.connection\.string$/, ".connection_string");
    configPath = configPath.replace(/\.base\.url$/, ".base_url");
    configPath = configPath.replace(/\.default\.model$/, ".default_model");
    configPath = configPath.replace(/\.max\.tokens$/, ".max_tokens");
    
    // Set nested value in config object
    this.setNestedValue(config, configPath, value);
  }

  /**
   * Set a nested value in an object using dot notation
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split(".");
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key && !current[key]) {
        current[key] = {};
      }
      if (key) {
        current = current[key];
      }
    }
    
    const lastKey = keys[keys.length - 1];
    if (lastKey && current) {
      try {
        current[lastKey] = value;
      } catch (error) {
        // Handle readonly properties by creating a new object
        if (error instanceof TypeError && error.message.includes("readonly")) {
          // Skip readonly properties
          return;
        }
        throw error;
      }
    }
  }

  /**
   * Load global user configuration from XDG directory
   */
  private async loadGlobalUserConfig(): Promise<GlobalUserConfig | null> {
    const configPath = this.expandTilde(CONFIG_PATHS.GLOBAL_USER);

    if (!existsSync(configPath)) {
      return null as unknown;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" }).toString();
      const contentStr = typeof content === "string" ? content : (content as unknown).toString();
      return parseYaml(contentStr) as GlobalUserConfig;
    } catch (error) {
      // Use a simple fallback for logging since proper logging infrastructure may not be available yet
      (console as unknown).error(`Failed to load global user config from ${configPath}:`, error as unknown);
      return null as unknown;
    }
  }

  /**
   * Load repository configuration
   */
  private async loadRepositoryConfig(workingDir: string): Promise<RepositoryConfig | null> {
    const configPath = join(workingDir, CONFIG_PATHS.REPOSITORY);

    if (!existsSync(configPath)) {
      return null as unknown;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" }).toString();
      const contentStr = typeof content === "string" ? content : (content as unknown).toString();
      return parseYaml(contentStr) as RepositoryConfig;
    } catch (error) {
      // Silently fail - configuration loading should be resilient
      return null as unknown;
    }
  }

  /**
   * Merge configurations with proper precedence
   */
  private mergeConfigurations(sources: ConfigurationSources): ResolvedConfig {
    const { configOverrides, environment, globalUser, repository, defaults } = sources;

    // Provide sensible defaults for sessiondb
    const defaultSessionDb = this.mergeSessionDbConfig(undefined, {});

    // Start with defaults
    const resolved: ResolvedConfig = {
      backend: defaults.backend || "json-file",
      backendConfig: { ...defaults.backendConfig },
      detectionRules: [...(defaults.detectionRules || [])],
      sessiondb: defaultSessionDb,
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

      // Merge sessiondb config from repository
      if (repository.sessiondb) {
        // Convert repository sessiondb format to SessionDbConfig format
        const repoSessionDb: Partial<SessionDbConfig> = {
          backend: repository.sessiondb.backend,
          dbPath: repository.sessiondb.sqlite?.path,
          baseDir: repository.sessiondb.base_dir,
          connectionString: repository.sessiondb.postgres?.connection_string,
        };
        resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, repoSessionDb);
      }

      // Merge GitHub config from repository
      if (repository.github) {
        resolved.github = this.mergeGitHubConfig(resolved.github, repository.github);
      }

      // Merge AI config from repository
      if (repository.ai) {
        resolved.ai = this.mergeAIConfig(resolved.ai, repository.ai);
      }
    }

    // Apply global user config
    if (globalUser?.github) {
      resolved.github = this.mergeGitHubConfig(resolved.github, globalUser.github);
    }
    if (globalUser?.sessiondb) {
      // Convert global user sessiondb format to SessionDbConfig format
      const globalSessionDb: Partial<SessionDbConfig> = {
        dbPath: globalUser.sessiondb.sqlite?.path,
        baseDir: globalUser.sessiondb.base_dir,
      };
      resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, globalSessionDb);
    }
    if (globalUser?.ai) {
      resolved.ai = this.mergeAIConfig(resolved.ai, globalUser.ai);
    }
    if (globalUser?.postgres) {
      resolved.postgres = { ...globalUser.postgres };
    }

    // Apply environment overrides
    if (environment.backend) {
      resolved.backend = environment.backend;
    }
    if (environment.github) {
      resolved.github = this.mergeGitHubConfig(resolved.github, environment.github);
    }
    if (environment.ai) {
      resolved.ai = this.mergeAIConfig(resolved.ai, environment.ai);
    }
    if (environment.sessiondb) {
      resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, environment.sessiondb);
    }

    // Apply configuration overrides (highest priority)
    if (configOverrides.backend) {
      resolved.backend = configOverrides.backend;
    }
    if (configOverrides.github) {
      resolved.github = this.mergeGitHubConfig(resolved.github, configOverrides.github);
    }
    if (configOverrides.ai) {
      resolved.ai = this.mergeAIConfig(resolved.ai, configOverrides.ai);
    }
    if (configOverrides.sessiondb) {
      resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, configOverrides.sessiondb);
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
      merged["github-issues"] = {
        ...merged["github-issues"],
        ...repositoryBackends["github-issues"],
      };
    }

    return merged;
  }

  /**
   * Merge GitHub configurations
   */
  private mergeGitHubConfig(
    existing: GitHubConfig | undefined,
    newGitHub: GitHubConfig
  ): GitHubConfig {
    return {
      ...existing,
      ...newGitHub,
    };
  }

  /**
   * Merge AI configurations
   */
  private mergeAIConfig(
    existing: AIConfig | undefined,
    newAI: AIConfig
  ): AIConfig {
    const merged = { ...existing };

    if (newAI.default_provider) {
      merged.default_provider = newAI.default_provider;
    }

    if (newAI.providers) {
      merged.providers = {
        ...merged.providers,
        ...newAI.providers,
      };
    }

    return merged;
  }

  /**
   * Merge session database configurations
   */
  private mergeSessionDbConfig(
    existing: SessionDbConfig | undefined,
    newSessionDb: Partial<SessionDbConfig>
  ): SessionDbConfig {
    // Provide a sensible default baseDir if none is configured
    const defaultBaseDir = join(homedir(), ".local", "state", "minsky", "sessions");

    // Filter out undefined values from newSessionDb to prevent overwriting defaults
    const filteredNewSessionDb = Object.fromEntries(
      Object.entries(newSessionDb).filter(([key, value]) => value !== undefined)
    );

    const merged: SessionDbConfig = {
      backend: "json",
      baseDir: defaultBaseDir,
      ...existing,
      ...filteredNewSessionDb,
    };

    return merged;
  }

  /**
   * Expand tilde in file paths
   */
  private expandTilde(filePath: string): string {
    if ((filePath as unknown).startsWith("~/")) {
      return join(homedir(), (filePath as unknown).slice(2));
    }
    return filePath;
  }
}
