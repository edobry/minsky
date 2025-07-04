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
      defaults: DEFAULT_CONFIG,
    };

    // Merge with precedence: CLI > env > global user > repo > defaults
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
    if (process.env[ENV_VARS.BACKEND]) {
      config.backend = process.env[ENV_VARS.BACKEND] as any;
    }

    // GitHub token for credentials
    if (process.env[ENV_VARS.GITHUB_TOKEN]) {
      config.github = {
        credentials: {
          token: process.env[ENV_VARS.GITHUB_TOKEN],
          source: "environment",
        } as any,
      };
    }

    // SessionDB configuration overrides
    const sessionDbConfig: Partial<SessionDbConfig> = {};
    if (process.env[ENV_VARS.SESSIONDB_BACKEND]) {
      const backend = process.env[ENV_VARS.SESSIONDB_BACKEND];
      if (backend === "json" || backend === "sqlite" || backend === "postgres") {
        sessionDbConfig.backend = backend;
      }
    }
    if (process.env[ENV_VARS.SESSIONDB_SQLITE_PATH]) {
      sessionDbConfig.dbPath = process.env[ENV_VARS.SESSIONDB_SQLITE_PATH] as any;
    }
    if (process.env[ENV_VARS.SESSIONDB_POSTGRES_URL]) {
      sessionDbConfig.connectionString = process.env[ENV_VARS.SESSIONDB_POSTGRES_URL] as any;
    }
    if (process.env[ENV_VARS.SESSIONDB_BASE_DIR]) {
      sessionDbConfig.baseDir = process.env[ENV_VARS.SESSIONDB_BASE_DIR] as any;
    }

    if (Object.keys(sessionDbConfig).length > 0) {
      config.sessiondb = sessionDbConfig as SessionDbConfig;
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
      const content = readFileSync(configPath, { encoding: "utf8" });
      const contentStr = typeof content === "string" ? content : content.toString();
      return parseYaml(contentStr) as GlobalUserConfig;
    } catch (error) {
      // Use a simple fallback for logging since proper logging infrastructure may not be available yet
      console.error(`Failed to load global user config from ${configPath}:`, error as any);
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
      const content = readFileSync(configPath, { encoding: "utf8" });
      const contentStr = typeof content === "string" ? content : content.toString();
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
    const { cliFlags, environment, globalUser, repository, defaults } = sources;

    // Start with defaults
    const resolved: ResolvedConfig = {
      backend: defaults.backend || "json-file",
      backendConfig: { ...defaults.backendConfig },
      detectionRules: [...(defaults.detectionRules || [])],
      sessiondb: { ...defaults.sessiondb } as SessionDbConfig,
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

    // Apply CLI flags (highest priority)
    if (cliFlags.backend) {
      resolved.backend = cliFlags.backend;
    }
    if (cliFlags.github) {
      resolved.github = this.mergeGitHubConfig(resolved.github, cliFlags.github);
    }
    if (cliFlags.sessiondb) {
      resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, cliFlags.sessiondb);
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
    const merged: SessionDbConfig = {
      backend: "json",
      ...existing,
      ...newSessionDb,
    };

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
