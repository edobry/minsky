/**
 * Configuration system exports for Minsky
 *
 * This module provides the minimal exports needed for the node-config based
 * configuration system, maintaining backward compatibility where needed.
 */

// Node-config adapter for backward compatibility
export { NodeConfigAdapter } from "./node-config-adapter";

// Types and interfaces still needed
export type {
  ConfigurationService,
  ConfigurationLoadResult,
  ConfigurationSources,
  ResolvedConfig,
  RepositoryConfig,
  GlobalUserConfig,
  BackendConfig,
  CredentialConfig,
  DetectionRule,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  CredentialSource,
  CredentialManager,
  BackendDetector,
  SessionDbConfig,
  GitHubConfig,
  AIConfig,
  AIProviderConfig,
  PostgresConfig,
  LoggerConfig,
} from "./types";

// Constants
export { DEFAULT_CONFIG, CONFIG_PATHS, ENV_VARS } from "./types";

// Node-config is the primary configuration system
// Components should use: import config from "config"; config.get("key");
// This export is only for backward compatibility during transition
import { NodeConfigAdapter } from "./node-config-adapter";
export const configurationService = new NodeConfigAdapter();
