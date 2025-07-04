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
      const content = readFileSync(configPath, { encoding: "utf8" });
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
      const content = readFileSync(configPath, { encoding: "utf8" });
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
    const { cliFlags, environment, globalUser, repository, defaults } = sources;

    // Start with defaults
    const resolved: ResolvedConfig = {
      backend: (defaults as any).backend || "json-file",
      backendConfig: { ...(defaults as any).backendConfig },
      detectionRules: [...((defaults as any).detectionRules || [])],
      sessiondb: { ...(defaults as any).sessiondb } as SessionDbConfig,
    };

    // Apply repository config
    if (repository) {
      if ((repository.backends as any).default) {
        (resolved as any).backend = (repository.backends as any).default;
      }

      // Merge backend-specific configs
      if ((repository as any).backends) {
        (resolved as any).backendConfig = this.mergeBackendConfig(
          (resolved as any).backendConfig,
          (repository as any).backends
        );
      }

      // Use repository detection rules if available
      if ((repository.repository as any).detection_rules) {
        (resolved as any).detectionRules = (repository.repository as any).detection_rules;
      }

      // Merge sessiondb config from repository
      if ((repository as any).sessiondb) {
        // Convert repository sessiondb format to SessionDbConfig format
        const repoSessionDb: Partial<SessionDbConfig> = {
          backend: (repository.sessiondb as any).backend,
          dbPath: (repository.sessiondb.sqlite as any).path,
          baseDir: (repository.sessiondb as any).base_dir,
          connectionString: (repository.sessiondb.postgres as any).connection_string,
        };
        (resolved as any).sessiondb = this.mergeSessionDbConfig((resolved as any).sessiondb, repoSessionDb);
      }

      // Merge GitHub config from repository
      if ((repository as any).github) {
        (resolved as any).github = this.mergeGitHubConfig((resolved as any).github, (repository as any).github);
      }

      // Merge AI config from repository
      if ((repository as any).ai) {
        (resolved as any).ai = this.mergeAIConfig((resolved as any).ai, (repository as any).ai);
      }
    }

    // Apply global user config
    if ((globalUser as any).github) {
      (resolved as any).github = this.mergeGitHubConfig((resolved as any).github, (globalUser as any).github);
    }
    if ((globalUser as any).sessiondb) {
      // Convert global user sessiondb format to SessionDbConfig format
      const globalSessionDb: Partial<SessionDbConfig> = {
        dbPath: (globalUser.sessiondb.sqlite as any).path,
        baseDir: (globalUser.sessiondb as any).base_dir,
      };
      (resolved as any).sessiondb = this.mergeSessionDbConfig((resolved as any).sessiondb, globalSessionDb);
    }
    if ((globalUser as any).ai) {
      (resolved as any).ai = this.mergeAIConfig((resolved as any).ai, (globalUser as any).ai);
    }
    if ((globalUser as any).postgres) {
      (resolved as any).postgres = { ...(globalUser as any).postgres };
    }

    // Apply environment overrides
    if ((environment as any).backend) {
      (resolved as any).backend = (environment as any).backend;
    }
    if ((environment as any).github) {
      (resolved as any).github = this.mergeGitHubConfig((resolved as any).github, (environment as any).github);
    }
    if ((environment as any).sessiondb) {
      (resolved as any).sessiondb = this.mergeSessionDbConfig((resolved as any).sessiondb, (environment as any).sessiondb);
    }

    // Apply CLI flags (highest priority)
    if (cliFlags.backend) {
      (resolved as any).backend = cliFlags.backend;
    }
    if (cliFlags.github) {
      (resolved as any).github = this.mergeGitHubConfig((resolved as any).github, cliFlags.github);
    }
    if (cliFlags.sessiondb) {
      (resolved as any).sessiondb = this.mergeSessionDbConfig((resolved as any).sessiondb, cliFlags.sessiondb);
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
    
    if ((newGitHub as any).credentials) {
      (merged as any).credentials = {
        ...(merged as any).credentials,
        ...(newGitHub as any).credentials,
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
    
    if ((newAI as any).default_provider) {
      (merged as any).default_provider = (newAI as any).default_provider;
    }

    if ((newAI as any).providers) {
      (merged as any).providers = {
        ...(merged as any).providers,
        ...(newAI as any).providers,
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
    if ((filePath as any).startsWith("~/")) {
      return join(homedir(), (filePath as any).slice(2));
    }
    return filePath;
  }
}
