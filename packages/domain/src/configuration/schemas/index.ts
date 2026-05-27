/**
 * Root Configuration Schema
 *
 * Combines all domain-specific configuration schemas into a complete, type-safe
 * configuration system with validation and TypeScript integration.
 */

import { z } from "zod";

// Import all domain schemas
import {
  backendSchema,
  backendConfigSchema,
  repositoryConfigSchema,
  type Backend,
  type BackendConfig,
  type RepositoryConfig,
} from "./backend";

import { persistenceConfigSchema, type PersistenceConfig } from "./persistence";

import { githubConfigSchema, type GitHubConfig } from "./github";

import { aiConfigSchema, type AIConfig } from "./ai";

import { loggerConfigSchema, type LoggerConfig } from "./logger";

import { tasksConfigSchema, type TasksConfig } from "./tasks";
import { embeddingsConfigSchema, type EmbeddingsConfig } from "./embeddings";
import { workspaceConfigSchema, type WorkspaceConfig } from "./workspace";
import { rulesConfigSchema, type RulesConfig } from "./rules";
import { mcpConfigSchema, type McpConfig } from "./mcp";
import {
  knowledgeBasesConfigSchema,
  type KnowledgeBasesConfig,
  type KnowledgeBaseEntry,
} from "./knowledge-bases";
import { memoryConfigSchema, type MemoryConfig, type MemoryLoadingMode } from "./memory";
import {
  knowledgeReconciliationSchema,
  type KnowledgeReconciliationConfig,
} from "./knowledge-reconciliation";
import { supabaseConfigSchema, type SupabaseConfig } from "./supabase";
import { railwayConfigSchema, type RailwayConfig } from "./railway";
import {
  oauthConfigSchema,
  oauthProviderSchema,
  type OAuthConfig,
  type OAuthProvider,
} from "./oauth";

import {
  observabilityConfigSchema,
  type ObservabilityConfig,
  type BraintrustConfig,
  type ObservabilityProviderConfig,
  type ObservabilityProvidersConfig,
} from "./observability";

/**
 * Complete application configuration schema
 *
 * This is the root schema that defines the entire configuration structure
 * for the Minsky application, combining all domain-specific configurations.
 *
 * Strictness policy (mt#1612): the top-level shape is `strictObject` so
 * unknown top-level keys (typos, vestige fields) are rejected at load time.
 * Nested schemas inherit whatever strictness their domain file declares —
 * we deliberately do NOT auto-strict every nested object, because some
 * nested shapes (provider config blocks, backendConfig records) intentionally
 * accept open-ended keys. Audit and tighten on a case-by-case basis when
 * nested unknown-key drift becomes a known footgun.
 */
export const configurationSchema = z.strictObject({
  // Schema version marker for the config-file format. Optional;
  // present in user/repo YAML files written before this field was tracked.
  version: z.number().optional(),

  // Note: Deprecated root 'backend' property removed - use tasks.backend instead
  backendConfig: backendConfigSchema,

  // Modern persistence configuration
  persistence: persistenceConfigSchema.optional(),

  // GitHub integration configuration
  github: githubConfigSchema,

  // AI providers configuration
  ai: aiConfigSchema,

  // Embeddings configuration
  embeddings: embeddingsConfigSchema,

  // Logging configuration
  logger: loggerConfigSchema,

  // Tasks configuration
  tasks: tasksConfigSchema,

  // Workspace configuration
  workspace: workspaceConfigSchema,

  // Rules configuration
  rules: rulesConfigSchema,

  // Repository backend configuration (project-level, set during minsky init)
  repository: repositoryConfigSchema.optional(),

  // MCP transport configuration (project-level invariants set during minsky init)
  mcp: mcpConfigSchema,

  // Knowledge base sources configuration
  knowledgeBases: knowledgeBasesConfigSchema,

  // Memory loading configuration
  memory: memoryConfigSchema,

  // Knowledge reconciliation configuration (freshness + authority ranking)
  knowledgeReconciliation: knowledgeReconciliationSchema.optional(),

  // Supabase Management API credentials (developer-local; consumed by `just supabase-usage`)
  supabase: supabaseConfigSchema,

  // Railway API token for Pulumi IaC management (mt#2124 / mt#2138)
  railway: railwayConfigSchema,

  // OAuth identity provider configuration (mt#1634 / mt#1662)
  oauth: oauthConfigSchema,

  // Observability provider configuration (mt#1791 — Braintrust + future providers)
  observability: observabilityConfigSchema,
});
// strictObject: unknown top-level keys are rejected with an `unrecognized_keys`
// ZodError. Catches typos (e.g. `persistance:` for `persistence:`) and stale
// vestigial keys at load time instead of silently stripping them.

/**
 * Configuration type inferred from the schema
 */
export type Configuration = z.infer<typeof configurationSchema>;

/**
 * Deeply partial configuration type for overrides and partial updates
 */
export type PartialConfiguration = z.input<typeof configurationSchema>;

/**
 * Configuration validation result
 */
export interface ConfigurationValidationResult {
  success: boolean;
  data?: Configuration;
  error?: z.ZodError;
  issues?: z.ZodIssue[];
}

// Re-export all types for convenience
export type {
  Backend,
  BackendConfig,
  RepositoryConfig,
  PersistenceConfig,
  GitHubConfig,
  AIConfig,
  LoggerConfig,
  TasksConfig,
  EmbeddingsConfig,
  WorkspaceConfig,
  RulesConfig,
  McpConfig,
  KnowledgeBasesConfig,
  KnowledgeBaseEntry,
  MemoryConfig,
  MemoryLoadingMode,
  KnowledgeReconciliationConfig,
  SupabaseConfig,
  RailwayConfig,
  OAuthConfig,
  OAuthProvider,
  ObservabilityConfig,
  BraintrustConfig,
  ObservabilityProviderConfig,
  ObservabilityProvidersConfig,
};

// Re-export schemas for external use
export {
  backendSchema,
  backendConfigSchema,
  repositoryConfigSchema,
  persistenceConfigSchema,
  githubConfigSchema,
  aiConfigSchema,
  loggerConfigSchema,
  tasksConfigSchema,
  embeddingsConfigSchema,
  workspaceConfigSchema,
  rulesConfigSchema,
  mcpConfigSchema,
  knowledgeBasesConfigSchema,
  memoryConfigSchema,
  knowledgeReconciliationSchema,
  supabaseConfigSchema,
  railwayConfigSchema,
  oauthConfigSchema,
  oauthProviderSchema,
  observabilityConfigSchema,
};

// Export the main schema as default
export default configurationSchema;
