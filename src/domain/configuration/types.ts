/**
 * Configuration system types for Minsky
 *
 * This module defines the interfaces and types for the hierarchical configuration system
 * that supports both repository-level settings (committed) and global user settings.
 */

export interface RepositoryConfig {
  version: number;
  backends?: {
    default?: string;
    "github-issues"?: {
      owner: string;
      repo: string;
    };
    markdown?: Record<string, unknown>;
    "json-file"?: Record<string, unknown>;
  };
  repository?: {
    auto_detect_backend?: boolean;
    detection_rules?: DetectionRule[];
  };
}

export interface GlobalUserConfig {
  version: number;
  credentials?: {
    github?: {
      source: "environment" | "file" | "prompt";
      token?: string;
      token_file?: string;
    };
  };
  // Future: user preferences
}

export interface DetectionRule {
  condition: "json_file_exists" | "tasks_md_exists" | "always";
  backend: string;
}

export interface ResolvedConfig {
  backend: string;
  backendConfig: BackendConfig;
  credentials: CredentialConfig;
  detectionRules: DetectionRule[];
}

export interface BackendConfig {
  "github-issues"?: {
    owner: string;
    repo: string;
  };
  markdown?: Record<string, unknown>;
  "json-file"?: Record<string, unknown>;
}

export interface CredentialConfig {
  github?: {
    token?: string;
    source: "environment" | "file" | "prompt";
  };
}

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

export type CredentialSource = "environment" | "file" | "prompt";

export interface ConfigurationService {
  loadConfiguration(__workingDir: string): Promise<ConfigurationLoadResult>;
  validateRepositoryConfig(__config: RepositoryConfig): ValidationResult;
  validateGlobalUserConfig(__config: GlobalUserConfig): ValidationResult;
}

export interface CredentialManager {
  getCredential(_service: "github"): Promise<string | null>;
  setGlobalCredential(_service: "github", source: CredentialSource, value?: string): Promise<void>;
  promptForCredential(_service: "github"): Promise<string>;
}

export interface BackendDetector {
  detectBackend(__workingDir: string, rules: DetectionRule[]): Promise<string>;
  githubRemoteExists(__workingDir: string): Promise<boolean>;
  tasksMdExists(__workingDir: string): Promise<boolean>;
}

// Default configuration values
export const DEFAULT_CONFIG: Partial<ResolvedConfig> = {
  backend: "json-file",
  backendConfig: {},
  credentials: {},
  detectionRules: [
    { condition: "tasks_md_exists", backend: "markdown" },
    { condition: "json_file_exists", backend: "json-file" },
    { condition: "always", backend: "json-file" },
  ],
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
} as const;
