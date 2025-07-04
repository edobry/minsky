/**
 * Configuration system types for Minsky
 *
 * This module defines the interfaces and types for the hierarchical configuration system
 * that supports both repository-level settings (committed) and global user settings.
 */

// Component-specific configuration with colocated credentials

export interface GitHubConfig {
  credentials?: {
    source: "environment" | "file" | "prompt";
    token?: string;
    token_file?: string;
  };
  // Future: other GitHub settings can go here
}

export interface AIProviderConfig {
  credentials?: {
    source: "environment" | "file" | "prompt";
    api_key?: string;
    api_key_file?: string;
  };
  enabled?: boolean;
  default_model?: string;
  base_url?: string;
  models?: string[];
  max_tokens?: number;
  temperature?: number;
}

export interface AIConfig {
  default_provider?: string;
  providers?: {
    openai?: AIProviderConfig;
    anthropic?: AIProviderConfig;
    google?: AIProviderConfig;
    cohere?: AIProviderConfig;
    mistral?: AIProviderConfig;
  };
}

export interface PostgresConfig {
  connection_string?: string;
}

// Repository and Global User Configuration

export interface RepositoryConfig {
  version: number;
  backends?: {
    default?: string;
    "github-issues"?: {
      owner: string;
      repo: string;
    };
    markdown?: Record<string, any>;
    "json-file"?: Record<string, any>;
  };
  repository?: {
    auto_detect_backend?: boolean;
    detection_rules?: DetectionRule[];
  };
  sessiondb?: {
    backend?: "json" | "sqlite" | "postgres";
    sqlite?: {
      path?: string;
    };
    postgres?: {
      connection_string?: string;
    };
    base_dir?: string;
  };
  ai?: AIConfig;
  github?: GitHubConfig;
}

export interface GlobalUserConfig {
  version: number;
  github?: GitHubConfig;
  sessiondb?: {
    sqlite?: {
      path?: string;
    };
    base_dir?: string;
  };
  ai?: AIConfig;
  postgres?: PostgresConfig;
}

// Core Configuration Types

export interface DetectionRule {
  condition: "json_file_exists" | "tasks_md_exists" | "always";
  backend: string;
}

export interface ResolvedConfig {
  backend: string;
  backendConfig: BackendConfig;
  detectionRules: DetectionRule[];
  sessiondb: SessionDbConfig;
  github?: GitHubConfig;
  ai?: AIConfig;
  postgres?: PostgresConfig;
}

export interface BackendConfig {
  "github-issues"?: {
    owner: string;
    repo: string;
  };
  markdown?: Record<string, any>;
  "json-file"?: Record<string, any>;
}

export interface SessionDbConfig {
  backend: "json" | "sqlite" | "postgres";
  dbPath?: string;
  baseDir?: string;
  connectionString?: string;
}

// Configuration Management Types

export interface ConfigurationLoadResult {
  resolved: ResolvedConfig;
  sources: ConfigurationSources;
}

export interface ConfigurationSources {
  cliFlags: Partial<ResolvedConfig>;
  environment: Partial<ResolvedConfig>;
  globalUser: GlobalUserConfig | null;
  repository: RepositoryConfig | null;
  defaults: Partial<ResolvedConfig>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
}

// Service Interfaces

export type CredentialSource = "environment" | "file" | "prompt";

export interface ConfigurationService {
  loadConfiguration(_workingDir: string): Promise<ConfigurationLoadResult>;
  validateRepositoryConfig(_config: RepositoryConfig): ValidationResult;
  validateGlobalUserConfig(_config: GlobalUserConfig): ValidationResult;
}

export interface CredentialManager {
  getCredential(_service: "github"): Promise<string | null>;
  setGlobalCredential(
    _service: "github",
    source: CredentialSource,
    _value?: string
  ): Promise<void>;
  promptForCredential(_service: "github"): Promise<string>;
}

export interface BackendDetector {
  detectBackend(_workingDir: string, _rules: DetectionRule[]): Promise<string>;
  githubRemoteExists(_workingDir: string): Promise<boolean>;
  tasksMdExists(_workingDir: string): Promise<boolean>;
}

// Default configuration values
export const DEFAULT_CONFIG: Partial<ResolvedConfig> = {
  backend: "json-file",
  backendConfig: {},
  detectionRules: [
    { condition: "tasks_md_exists", backend: "markdown" },
    { condition: "json_file_exists", backend: "json-file" },
    { condition: "always", backend: "json-file" },
  ],
  sessiondb: {
    backend: "json",
    baseDir: undefined,
    dbPath: undefined,
    connectionString: undefined,
  },
};

// Configuration file paths
export const CONFIG_PATHS = {
  REPOSITORY: ".minsky/config.yaml",
  GLOBAL_USER: "~/.config/minsky/config.yaml",
} as const;

// Environment variable names
export const ENV_VARS = {
  BACKEND: "MINSKY_BACKEND",
  GITHUB_TOKEN: "GITHUB_TOKEN",
  SESSIONDB_BACKEND: "MINSKY_SESSIONDB_BACKEND",
  SESSIONDB_SQLITE_PATH: "MINSKY_SESSIONDB_SQLITE_PATH",
  SESSIONDB_POSTGRES_URL: "MINSKY_SESSIONDB_POSTGRES_URL",
  SESSIONDB_BASE_DIR: "MINSKY_SESSIONDB_BASE_DIR",
} as const;
