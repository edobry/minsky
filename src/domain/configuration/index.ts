/**
 * Configuration system exports for Minsky
 *
 * This module provides the main exports for the configuration system,
 * making it easy for other parts of the codebase to import and use
 * configuration functionality.
 */

// Core service and components
export { NodeConfigAdapter } from "./node-config-adapter";
export { DefaultCredentialManager } from "./credential-manager";

// Types and interfaces
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
  SessionDbConfig,
} from "./types";

// Constants
export { DEFAULT_CONFIG, CONFIG_PATHS, ENV_VARS } from "./types";

// Import the class to create singleton instance
import { NodeConfigAdapter } from "./node-config-adapter.js";

// Create a singleton instance for easy usage
// Using NodeConfigAdapter for backward compatibility with node-config migration
export const configurationService = new NodeConfigAdapter();
