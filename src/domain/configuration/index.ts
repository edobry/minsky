/**
 * Configuration system exports for Minsky
 *
 * This module provides the main exports for the configuration system,
 * making it easy for other parts of the codebase to import and use
 * configuration functionality.
 */

// Core service and components
export { DefaultConfigurationService } from "./configuration-service";
export { NodeConfigAdapter } from "./node-config-adapter";
export { ConfigurationLoader } from "./config-loader";
export { DefaultCredentialManager } from "./credential-manager";
export { DefaultBackendDetector } from "./backend-detector";

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
  BackendDetector,
} from "./types";

// Constants
export { DEFAULT_CONFIG, CONFIG_PATHS, ENV_VARS } from "./types";

// Import the class to create singleton instance
import { DefaultConfigurationService } from "./configuration-service";

// Create a singleton instance for easy usage
// Using DefaultConfigurationService for proper workingDir handling
export const configurationService = new DefaultConfigurationService();
