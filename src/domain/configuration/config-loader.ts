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
   */
  private loadEnvironmentConfig(): Partial<ResolvedConfig> {
    const config: Partial<ResolvedConfig> = {};

    // Backend override
    if ((process as any).env[ENV_VARS.BACKEND]) {
      (config as any).backend = (process as any).env[ENV_VARS.BACKEND] as any;
    }

    // GitHub token for credentials
    if ((process as any).env[ENV_VARS.GITHUB_TOKEN]) {
      (config as any).github = {
        credentials: {
          token: (process as any).env[ENV_VARS.GITHUB_TOKEN],
          source: "environment",
        } as any,
      };
    }

    // SessionDB configuration overrides
    const sessionDbConfig: Partial<SessionDbConfig> = {};
    if ((process as any).env[ENV_VARS.SESSIONDB_BACKEND]) {
      const backend = (process as any).env[ENV_VARS.SESSIONDB_BACKEND];
      if (backend === "json" || backend === "sqlite" || backend === "postgres") {
        (sessionDbConfig as any).backend = backend;
      }
    }
    if ((process as any).env[ENV_VARS.SESSIONDB_SQLITE_PATH]) {
      (sessionDbConfig as any).dbPath = (process as any).env[ENV_VARS.SESSIONDB_SQLITE_PATH] as any;
    }
    if ((process as any).env[ENV_VARS.SESSIONDB_POSTGRES_URL]) {
      (sessionDbConfig as any).connectionString = (process as any).env[ENV_VARS.SESSIONDB_POSTGRES_URL] as any;
    }
    if ((process as any).env[ENV_VARS.SESSIONDB_BASE_DIR]) {
      (sessionDbConfig as any).baseDir = (process as any).env[ENV_VARS.SESSIONDB_BASE_DIR] as any;
    }

    if ((Object.keys(sessionDbConfig) as any).length > 0) {
      (config as any).sessiondb = sessionDbConfig as SessionDbConfig;
    }

    return config;
  }

  /**
   * Load global user configuration from XDG directory
   */
  private async loadGlobalUserConfig(): Promise<GlobalUserConfig | null> {
    const configPath = this.expandTilde(CONFIG_PATHS.GLOBAL_USER);

    if (!existsSync(configPath)) {
      return null as any;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" }).toString();
      const contentStr = typeof content === "string" ? content : (content as any).toString();
      return parseYaml(contentStr) as GlobalUserConfig;
    } catch (error) {
      // Use a simple fallback for logging since proper logging infrastructure may not be available yet
      (console as any).error(`Failed to load global user config from ${configPath}:`, error as any);
      return null as any;
    }
  }

  /**
   * Load repository configuration
   */
  private async loadRepositoryConfig(workingDir: string): Promise<RepositoryConfig | null> {
    const configPath = join(workingDir, CONFIG_PATHS.REPOSITORY);

    if (!existsSync(configPath)) {
      return null as any;
    }

    try {
      const content = readFileSync(configPath, { encoding: "utf8" }).toString();
      const contentStr = typeof content === "string" ? content : (content as any).toString();
      return parseYaml(contentStr) as RepositoryConfig;
    } catch (error) {
      // Silently fail - configuration loading should be resilient
      return null as any;
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
    const merged = { ...existing };

    if (newGitHub.credentials) {
      merged.credentials = {
        ...merged.credentials,
        ...newGitHub.credentials,
      };
    }

    return merged;
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
    if ((filePath as any).startsWith("~/")) {
      return join(homedir(), (filePath as any).slice(2));
    }
    return filePath;
  }
}
