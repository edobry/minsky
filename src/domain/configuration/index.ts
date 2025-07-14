/**
 * Configuration system exports for Minsky
 *
 * This module provides idiomatic node-config usage with Zod validation
 * instead of the old NodeConfigAdapter anti-pattern.
 */

// Zod validation schemas and functions
export {
  validateConfig,
  validateRepositoryConfig,
  validateGlobalUserConfig,
  SessionDbConfigSchema,
  AIConfigSchema,
  AIProviderConfigSchema,
  GitHubConfigSchema,
  LoggerConfigSchema,
  DetectionRuleSchema,
  BackendConfigSchema,
  ConfigSchema,
  RepositoryConfigSchema,
  GlobalUserConfigSchema,
  type SessionDbConfig,
  type AIConfig,
  type AIProviderConfig,
  type GitHubConfig,
  type LoggerConfig,
  type DetectionRule,
  type BackendConfig,
  type Config,
  type RepositoryConfig,
  type GlobalUserConfig,
  type ValidationResult,
  type ValidationError,
  type ValidationWarning,
} from "./config-schemas";

// Legacy types still needed for backward compatibility
export type {
  ConfigurationLoadResult,
  ConfigurationSources,
  ResolvedConfig,
  CredentialConfig,
  CredentialSource,
  CredentialManager,
  BackendDetector,
  PostgresConfig,
} from "./types";

// Constants
export { DEFAULT_CONFIG, CONFIG_PATHS, ENV_VARS } from "./types";

// **RECOMMENDED USAGE: Direct node-config access**
// 
// Instead of using configurationService or NodeConfigAdapter,
// use node-config directly for idiomatic configuration access:
//
// ```typescript
// import config from "config";
// import { validateConfig, type SessionDbConfig } from "./config-schemas";
// 
// // Direct access with type safety
// const sessiondbConfig = config.get<SessionDbConfig>("sessiondb");
// const backend = config.get<string>("backend");
// 
// // Validation with Zod
// const validation = validateConfig(config);
// if (!validation.valid) {
//   console.error("Configuration validation failed:", validation.errors);
// }
// ```
//
// This approach provides:
// - Type safety with TypeScript generics
// - Runtime validation with Zod schemas
// - Standard node-config patterns
// - No unnecessary abstraction layers
