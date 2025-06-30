/**
 * Configuration system exports for Minsky (post node-config migration)
 *
 * This module provides the essential exports after migrating to node-config.
 */

// Main configuration adapter
export { NodeConfigAdapter } from "./node-config-adapter";

// Essential types still needed
export type {
  SessionDbConfig,
  DetectionRule,
  AIProviderRepoConfig,
  AIProviderUserConfig,
  AICredentialConfig,
  CredentialSource,
} from "./types";

// Create a singleton instance for easy usage
import { NodeConfigAdapter } from "./node-config-adapter.js";
export const configurationService = new NodeConfigAdapter(); 
