/**
 * Configuration loader for Minsky - Hybrid Implementation
 *
 * INCREMENTAL MIGRATION: This implementation uses node-config as the foundation
 * but adds domain-specific logic on top for backward compatibility.
 *
 * This allows:
 * - Tests to continue working during migration
 * - Domain logic to be preserved (credentials, path resolution, validation)
 * - Gradual extraction of domain services
 * - Simple configuration to use node-config directly
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { homedir } from "os";
import config from "config";
import {
  ConfigurationLoadResult,
  ConfigurationSources,
  ResolvedConfig,
  RepositoryConfig,
  GlobalUserConfig,
  BackendConfig,
  CredentialConfig,
  SessionDbConfig,
  DEFAULT_CONFIG,
  CONFIG_PATHS,
  ENV_VARS,
} from "./types";

export class ConfigurationLoader {
  /**
   * Load configuration from all sources with proper precedence
   * HYBRID: Uses node-config + domain logic for incremental migration
   */
  async loadConfiguration(
    workingDir: string,
    cliFlags: Partial<ResolvedConfig> = {}
  ): Promise<ConfigurationLoadResult> {
    // STEP 1: Get base configuration from node-config
    const nodeConfigBase = this.getNodeConfigBase();
    
    // STEP 2: Load domain-specific sources (for complex logic preservation)
    const sources: ConfigurationSources = {
      cliFlags,
      environment: this.loadEnvironmentConfig(),
      globalUser: await this.loadGlobalUserConfig(),
      repository: await this.loadRepositoryConfig(workingDir),
      defaults: DEFAULT_CONFIG,
    };

    // STEP 3: Merge node-config base with domain logic
    const resolved = this.mergeWithNodeConfig(nodeConfigBase, sources);

    return {
      resolved,
      sources,
    };
  }

  /**
   * Get base configuration from node-config
   * This handles the standard configuration loading patterns
   */
  private getNodeConfigBase(): Partial<ResolvedConfig> {
    try {
      // Get node-config values with proper fallbacks
      const base: Partial<ResolvedConfig> = {
        backend: config.has("backend") ? config.get("backend") : "json-file",
        sessiondb: config.has("sessiondb") ? config.get("sessiondb") : {
          backend: "json",
          baseDir: join(homedir(), ".local/state/minsky/git"),
        },
      };
      
      return base;
    } catch (error) {
      // Fallback to defaults if node-config fails
      return {
        backend: "json-file",
        sessiondb: {
          backend: "json",
          baseDir: join(homedir(), ".local/state/minsky/git"),
        },
      };
    }
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
          source: "environment",
        },
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
      sessionDbConfig.dbPath = process.env[ENV_VARS.SESSIONDB_SQLITE_PATH];
    }
    if (process.env[ENV_VARS.SESSIONDB_POSTGRES_URL]) {
      sessionDbConfig.connectionString = process.env[ENV_VARS.SESSIONDB_POSTGRES_URL];
    }
    if (process.env[ENV_VARS.SESSIONDB_BASE_DIR]) {
      sessionDbConfig.baseDir = process.env[ENV_VARS.SESSIONDB_BASE_DIR];
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
      return null;
    }

    try {
      const content = readFileSync(configPath, "utf8") as string;
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
      const content = readFileSync(configPath, "utf8") as string;
      return parseYaml(content) as RepositoryConfig;
    } catch (error) {
      // Silently fail - configuration loading should be resilient
      return null;
    }
  }

  /**
   * Merge node-config base with domain-specific configuration sources
   * This preserves domain logic while using node-config for basic loading
   */
  private mergeWithNodeConfig(
    nodeConfigBase: Partial<ResolvedConfig>,
    sources: ConfigurationSources
  ): ResolvedConfig {
    // Start with node-config base (handles standard config loading)
    const resolved: ResolvedConfig = {
      backend: nodeConfigBase.backend || "json-file",
      backendConfig: { ...DEFAULT_CONFIG.backendConfig },
      credentials: { ...DEFAULT_CONFIG.credentials },
      detectionRules: [...(DEFAULT_CONFIG.detectionRules || [])],
      sessiondb: { 
        backend: "json",
        baseDir: join(homedir(), ".local/state/minsky/git"),
        ...nodeConfigBase.sessiondb 
      } as SessionDbConfig,
    };

    // Apply domain-specific logic from repository config
    if (sources.repository) {
      if (sources.repository.backends?.default) {
        resolved.backend = sources.repository.backends.default;
      }

      if (sources.repository.backends) {
        resolved.backendConfig = this.mergeBackendConfig(
          resolved.backendConfig,
          sources.repository.backends
        );
      }

      if (sources.repository.repository?.detection_rules) {
        resolved.detectionRules = sources.repository.repository.detection_rules;
      }

      if (sources.repository.sessiondb) {
        const repoSessionDb: Partial<SessionDbConfig> = {
          backend: sources.repository.sessiondb.backend,
          dbPath: sources.repository.sessiondb.sqlite?.path,
          baseDir: sources.repository.sessiondb.base_dir,
          connectionString: sources.repository.sessiondb.postgres?.connection_string,
        };
        resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, repoSessionDb);
      }
    }

    // Apply domain-specific logic from global user config
    if (sources.globalUser?.credentials) {
      resolved.credentials = this.mergeCredentials(resolved.credentials, sources.globalUser.credentials);
    }
    if (sources.globalUser?.sessiondb) {
      const globalSessionDb: Partial<SessionDbConfig> = {
        dbPath: sources.globalUser.sessiondb.sqlite?.path,
        baseDir: sources.globalUser.sessiondb.base_dir,
      };
      resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, globalSessionDb);
    }

    // Apply environment variables (domain-specific override)
    if (sources.environment) {
      if (sources.environment.backend) {
        resolved.backend = sources.environment.backend;
      }
      if (sources.environment.credentials) {
        resolved.credentials = this.mergeCredentials(resolved.credentials, sources.environment.credentials);
      }
      if (sources.environment.sessiondb) {
        resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, sources.environment.sessiondb);
      }
    }

    // Apply CLI flags (highest priority)
    if (sources.cliFlags) {
      if (sources.cliFlags.backend) {
        resolved.backend = sources.cliFlags.backend;
      }
      if (sources.cliFlags.credentials) {
        resolved.credentials = this.mergeCredentials(resolved.credentials, sources.cliFlags.credentials);
      }
      if (sources.cliFlags.sessiondb) {
        resolved.sessiondb = this.mergeSessionDbConfig(resolved.sessiondb, sources.cliFlags.sessiondb);
      }
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
   * Merge sessiondb configurations
   */
  private mergeSessionDbConfig(
    existing: SessionDbConfig | undefined,
    newSessionDb: Partial<SessionDbConfig>
  ): SessionDbConfig {
    const existingConfig = existing || {
      backend: "json",
      baseDir: undefined,
      dbPath: undefined,
      connectionString: undefined,
    };
    return {
      backend: newSessionDb.backend || existingConfig.backend,
      baseDir: newSessionDb.baseDir || existingConfig.baseDir,
      dbPath: newSessionDb.dbPath || existingConfig.dbPath,
      connectionString: newSessionDb.connectionString || existingConfig.connectionString,
    };
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
