/**
 * Environment Variable Configuration Source
 *
 * Maps environment variables to configuration values using automatic pattern matching and explicit mappings. Provides the highest priority configuration source.
 */

import type { PartialConfiguration } from "../schemas";
import { elementAt } from "../../../utils/array-safety";

/**
 * Environment variable to configuration path mappings
 *
 * These mappings define how environment variables are translated into
 * configuration object paths.
 */
export const environmentMappings = {
  // Note: MINSKY_BACKEND removed - deprecated property, use tasks.backend config instead

  // Workspace configuration (NEW)
  MINSKY_WORKSPACE_MAIN_PATH: "workspace.mainPath",

  // GitHub configuration
  GITHUB_TOKEN: "github.token",
  GH_TOKEN: "github.token", // Fallback for GitHub CLI
  GITHUB_ORGANIZATION: "github.organization",
  GITHUB_REPOSITORY: "github.repository",
  GITHUB_BASE_URL: "github.baseUrl",
  GITHUB_API_URL: "github.baseUrl",

  // GitHub App service account configuration
  MINSKY_APP_ID: "github.serviceAccount.appId",
  MINSKY_APP_PRIVATE_KEY_FILE: "github.serviceAccount.privateKeyFile",
  MINSKY_APP_INSTALLATION_ID: "github.serviceAccount.installationId",
  MINSKY_GITHUB_APP_PRIVATE_KEY: "github.serviceAccount.privateKey",

  // AI provider configuration
  OPENAI_API_KEY: "ai.providers.openai.apiKey",
  OPENAI_ORGANIZATION: "ai.providers.openai.organization",
  OPENAI_BASE_URL: "ai.providers.openai.baseUrl",

  ANTHROPIC_API_KEY: "ai.providers.anthropic.apiKey",
  ANTHROPIC_BASE_URL: "ai.providers.anthropic.baseUrl",

  GOOGLE_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_AI_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_PROJECT_ID: "ai.providers.google.projectId",

  COHERE_API_KEY: "ai.providers.cohere.apiKey",

  MISTRAL_API_KEY: "ai.providers.mistral.apiKey",

  AI_DEFAULT_PROVIDER: "ai.defaultProvider",

  // Observability provider configuration (mt#1791)
  BRAINTRUST_API_KEY: "observability.providers.braintrust.apiKey",
  BRAINTRUST_PROJECT_NAME: "observability.providers.braintrust.projectName",
  BRAINTRUST_API_URL: "observability.providers.braintrust.apiUrl",

  // Persistence configuration (modern — populates `persistence.*`)
  MINSKY_PERSISTENCE_BACKEND: "persistence.backend",
  MINSKY_PERSISTENCE_SQLITE_PATH: "persistence.sqlite.dbPath",
  MINSKY_PERSISTENCE_POSTGRES_URL: "persistence.postgres.connectionString",

  // Persistence configuration (modern key). MINSKY_POSTGRES_URL is the canonical
  // escape hatch documented in persistence-config.ts and surfaced in factory /
  // validation error messages; it requires an explicit mapping because the
  // auto-conversion fallback would route it to "postgres.url" instead of
  // "persistence.postgres.connectionString".
  MINSKY_POSTGRES_URL: "persistence.postgres.connectionString",

  // Session-mode connection string for LISTEN/NOTIFY operations (mt#1852).
  // Supavisor transaction pooler (:6543) is LISTEN-incompatible; session mode
  // (:5432) keeps backend connections alive across commands. When unset, the
  // provider auto-derives by swapping :6543 → :5432 from connectionString.
  MINSKY_POSTGRES_SESSION_URL: "persistence.postgres.sessionConnectionString",

  // Supabase Management API credentials (developer-local; consumed by
  // `just supabase-usage`). Distinct from the Postgres connection string,
  // which lives under MINSKY_PERSISTENCE_POSTGRES_URL.
  MINSKY_SUPABASE_ACCESS_TOKEN: "supabase.accessToken",

  // OAuth configuration
  MINSKY_OAUTH_SIGNING_KEY: "oauth.signingKey",

  // Logger configuration
  MINSKY_LOG_MODE: "logger.mode",
  LOG_MODE: "logger.mode",
  LOGLEVEL: "logger.level",
  LOG_LEVEL: "logger.level",
  MINSKY_LOG_LEVEL: "logger.level",
  ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  MINSKY_ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  LOG_FILE: "logger.logFile",
  MINSKY_LOG_FILE: "logger.logFile",
} as const;

/**
 * Hook-only environment variables (mt#1644).
 *
 * These vars are read by `.claude/hooks/*.ts` subprocesses (external
 * consumers — the hook tree lives outside this package's import graph) but
 * have NO config-schema home. They are deliberately NOT in
 * `environmentMappings`.
 *
 * Without this skip-list, the auto-mapping fallback in
 * `loadEnvironmentConfiguration` would route them to camelCase config paths
 * (e.g. `MINSKY_FORCE_PARALLEL` -> `force.parallel`), which mt#1612's
 * strict-mode top-level validation rejects, crashing the CLI at startup.
 *
 * Both `loadEnvironmentConfiguration` and `getEnvironmentConfiguration`
 * honor this set so the loaded-config and metadata-reporting paths stay
 * consistent — diagnostics that consume `metadata.loadedVariables` see the
 * same view of "what env vars affected configuration" that the loader used.
 *
 * Keep in sync with `.claude/hooks/*.ts` as new hook-only `MINSKY_*` env
 * vars are introduced.
 */
// Exported so the lint rule `eslint-rules/no-unregistered-minsky-env-var.js`
// (mt#1788) can grep this file for the canonical allowlist. The rule does
// AST-based extraction (since ESLint runs under Node and can't import .ts),
// so the export is a parallel signal — the const stays here regardless.
// eslint-disable-next-line custom/no-domain-singleton
export const HOOK_ONLY_ENV_VARS: ReadonlySet<string> = new Set([
  "MINSKY_FORCE_PARALLEL", // .claude/hooks/parallel-work-guard.ts
  "MINSKY_SKIP_FRESHNESS", // .claude/hooks/check-branch-fresh.ts
  "MINSKY_TWO_STRIKES_STATE_DIR", // .claude/hooks/two-strikes-record.ts
  "MINSKY_TWO_STRIKES_MODE", // .claude/hooks/two-strikes-record.ts
  "MINSKY_SKIP_BUNDLE_SMOKE", // .claude/hooks/require-review-before-merge.ts (mt#1787)
  "MINSKY_SKIP_REQUIRED_CHECKS", // .claude/hooks/require-review-before-merge.ts (mt#1938)
  "MINSKY_SKIP_SMOKE_CHECK", // .claude/hooks/require-review-before-merge.ts (mt#2060)
  "MINSKY_SKIP_NUL_CHECK", // src/hooks/pre-commit.ts (mt#1824) — NUL-byte check override
  "MINSKY_SKIP_WORKSPACE_COPY_CHECK", // src/hooks/pre-commit.ts (mt#1984) — workspace-COPY check override
  "MINSKY_SKIP_MIGRATION_JOURNAL_CHECK", // src/hooks/pre-commit.ts (mt#2087) — migration journal consistency check override
  "MINSKY_SKIP_CLI_AUTORUN", // src/cli.ts (mt#1892) — gates the auto-main() invocation for build scripts that need to import createCli without running it
  // mt#1788 sweep — pre-existing src/ reads now registered as hook-only.
  // Many of these arguably belong in environmentMappings with a proper config
  // path; that promotion is a follow-up. The immediate goal is making the
  // env-var-to-config parser SKIP them so Railway env-var sets don't crash
  // the loader. Each entry is annotated with a representative read site.
  "MINSKY_NON_INTERACTIVE", // src/cli.ts, src/utils/interactive.ts (UX flag)
  "MINSKY_VERBOSE", // src/adapters/cli/utils/error-handler.ts (debug flag)
  "MINSKY_SHOW_SQL", // (debug flag — promote to logger.* if it grows)
  "MINSKY_STATE_DIR", // src/mcp/disconnect-tracker.ts (process-local path override)
  "MINSKY_DEPLOY_MEMORY_FILE", // (deployment-time bootstrap; not config)
  "MINSKY_MAIN_WORKSPACE", // (test-fixture constant)
  "MINSKY_SESSIONDB_POSTGRES_URL", // legacy detection (post-mt#1610 retire)
  "MINSKY_MCP_AUTH_TOKEN", // src/mcp (auth — promote to mcp.auth.token)
  "MINSKY_MCP_MAX_SESSIONS", // src/mcp/server.ts (server config — promote to mcp.maxSessions)
  "MINSKY_MCP_PROFILE", // src/utils/cold-start-profile.ts (debug flag)
  "MINSKY_MCP_RETRY_AFTER_SECS", // src/mcp (server config — promote to mcp.retryAfterSecs)
  "MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS", // src/mcp (server config — promote to mcp.sessionIdleTimeoutMs)
  "MINSKY_MCP_TOOL_NAMES", // src/mcp/server.ts (naming convention flag)
  "MINSKY_MCP_MEMORY_ENRICHMENT", // src/mcp (feature flag)
  "MINSKY_MCP_MEMORY_ENRICHMENT_TIMEOUT_MS", // src/mcp (feature config)
  "MINSKY_MCP_INSTRUCTIONS_BUNDLE", // src/mcp/middleware/memory-bundle.ts (mt#1625 spike — opt-in flag)
  "MINSKY_MCP_INIT_RETRY_INTERVAL_MS", // src/commands/mcp/start-command.ts (mt#1962 — init retry backoff)
  "MINSKY_POSTGRES_MAX_CONNECTIONS", // src/domain (pool config — promote to persistence.postgres.maxConnections)
  // mt#1994 — hook-only override env vars whose only read site is in
  // .claude/hooks/*.ts (outside the mt#1788 ESLint rule's prior scan path).
  // Each is documented in CLAUDE.md or the hook's own header as a user-facing
  // escape valve. Without registration, setting any of these crashes the CLI
  // at boot because the env-var-to-config dot-path parser converts e.g.
  // `MINSKY_ACK_OOB_MERGE` → `ack.oob.merge`, which the strict config schema
  // rejects (`Unrecognized key: "ack"`). The mt#1994 PR also extends the
  // ESLint rule to scan .claude/hooks/**/*.ts so future hook authors can't
  // reintroduce the gap.
  "MINSKY_ACK_OOB_MERGE", // .claude/hooks/block-out-of-band-merge.ts (mt#1695)
  "MINSKY_FORCE_EDIT_GENERATED", // .claude/hooks/check-generated-file-edit.ts (mt#1699)
  "MINSKY_SKIP_SKILL_STALENESS", // .claude/hooks/skill-staleness-detector.ts (mt#1622)
  "MINSKY_HOME", // .claude/hooks/mcp-daemon-staleness-detector.ts + src/mcp/daemon-state.ts (state-dir override)
  "MINSKY_FORCE_LOOP_TERMINAL", // .claude/hooks/loop-preflight-pr-merge-check.ts
  "MINSKY_POLICY_COVERAGE_MODE", // .claude/hooks/policy-coverage-detector.ts (mt#1541)
  "MINSKY_SKIP_DAEMON_STALENESS", // .claude/hooks/mcp-daemon-staleness-detector.ts
  "MINSKY_UNASKED_DIRECTION_DETECTOR", // .claude/hooks/post-merge-unasked-direction-scan.ts
  // mt#1767 — auto-migration controls in postgres-provider.ts. Process-only;
  // they govern boot-time behavior, not runtime config. Adding to the
  // hook-only set so Railway env-var sets (e.g. MINSKY_AUTO_MIGRATE=false
  // as the documented escape valve) don't crash the loader via the
  // env-var-to-config dot-path parser.
  "MINSKY_AUTO_MIGRATE", // src/domain/persistence/providers/postgres-provider.ts (auto-migrate opt-out)
  "MINSKY_MIGRATIONS_FOLDER", // src/domain/persistence/providers/postgres-provider.ts (migrations path override)
  "MINSKY_ACK_SUBSTRATE_BYPASS", // .claude/hooks/substrate-bypass-detector.ts (mt#2020) — override for substrate-bypass warning injection
  "MINSKY_ACK_RETROSPECTIVE_TRIGGER", // .claude/hooks/retrospective-trigger-scanner.ts (mt#2057) — override for retrospective-trigger warning injection
  "MINSKY_SKIP_BRIDGE_RETIREMENT", // .claude/hooks/bridge-memory-retirement.ts (mt#2062) — suppress bridge-memory retirement reminder
  "MINSKY_COCKPIT_PREVIEW", // src/cockpit/server.ts (mt#2096) — preview-mode guard disabling mutation endpoints
]);

/**
 * Type conversion functions for environment variables
 */
const typeConverters = {
  string: (value: string): string => value,
  number: (value: string): number => Number(value),
  boolean: (value: string): boolean => {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  },
  json: (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return value; // Fall back to string if JSON parsing fails
    }
  },
} as const;

/**
 * Field type mappings for automatic conversion
 */
const fieldTypes: Record<string, keyof typeof typeConverters> = {
  // Numbers
  "github.serviceAccount.appId": "number",
  "github.serviceAccount.installationId": "number",
  "logger.maxFileSize": "number",
  "logger.maxFiles": "number",
  "ai.providers.openai.maxTokens": "number",
  "ai.providers.anthropic.maxTokens": "number",
  "ai.providers.google.maxTokens": "number",
  "ai.providers.cohere.maxTokens": "number",
  "ai.providers.mistral.maxTokens": "number",
  "ai.providers.openai.temperature": "number",
  "ai.providers.anthropic.temperature": "number",
  "ai.providers.google.temperature": "number",
  "ai.providers.cohere.temperature": "number",
  "ai.providers.mistral.temperature": "number",

  // Booleans
  "logger.enableAgentLogs": "boolean",
  "logger.includeTimestamp": "boolean",
  "logger.includeLevel": "boolean",
  "logger.includeSource": "boolean",
  "ai.providers.openai.enabled": "boolean",
  "ai.providers.anthropic.enabled": "boolean",
  "ai.providers.google.enabled": "boolean",
  "ai.providers.cohere.enabled": "boolean",
  "ai.providers.mistral.enabled": "boolean",

  // JSON (arrays and objects)
  "ai.providers.openai.models": "json",
  "ai.providers.anthropic.models": "json",
  "ai.providers.google.models": "json",
  "ai.providers.cohere.models": "json",
  "ai.providers.mistral.models": "json",
  "ai.providers.openai.headers": "json",
  "ai.providers.anthropic.headers": "json",
  "ai.providers.google.headers": "json",
  "ai.providers.cohere.headers": "json",
  "ai.providers.mistral.headers": "json",
} as const;

/**
 * Load configuration from environment variables
 */
export function loadEnvironmentConfiguration(): PartialConfiguration {
  const config: Record<string, unknown> = {};

  // Process explicit mappings
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    const value = process.env[envVar];
    if (value !== undefined && value !== "") {
      setConfigValue(config, configPath, value);
    }
  }

  // Process MINSKY_ prefixed variables (automatic mapping)
  for (const [envVar, value] of Object.entries(process.env)) {
    if (envVar.startsWith("MINSKY_") && value !== undefined && value !== "") {
      // Skip if already handled by explicit mapping
      if (envVar in environmentMappings) continue;

      // Skip hook-only env vars — see HOOK_ONLY_ENV_VARS docstring (mt#1644).
      if (HOOK_ONLY_ENV_VARS.has(envVar)) continue;

      // Convert MINSKY_PREFIX to config path
      const configPath = envVarToConfigPath(envVar);
      if (configPath) {
        setConfigValue(config, configPath, value);
      }
    }
  }

  return config;
}

/**
 * Convert environment variable name to configuration path
 */
function envVarToConfigPath(envVar: string): string | null {
  // Remove MINSKY_ prefix
  const withoutPrefix = envVar.replace(/^MINSKY_/, "");

  // Convert SCREAMING_SNAKE_CASE to dot.notation.path
  const parts = withoutPrefix.toLowerCase().split("_");

  // Handle known patterns
  if (parts[0] === "ai" && parts[1] === "providers" && parts.length >= 3) {
    // AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.apiKey
    const provider = elementAt(parts, 2, "env var AI provider part");
    const field = parts.slice(3).join("_");
    return `ai.providers.${provider}.${camelCase(field)}`;
  }

  if (parts[0] === "persistence") {
    // PERSISTENCE_BACKEND -> persistence.backend
    // PERSISTENCE_SQLITE_DBPATH -> persistence.sqlite.dbPath
    // PERSISTENCE_POSTGRES_CONNECTIONSTRING -> persistence.postgres.connectionString
    if (parts.length === 2) {
      return `persistence.${camelCase(elementAt(parts, 1, "persistence field"))}`;
    } else if (parts.length >= 3) {
      const tail = parts.slice(2).join("_");
      return `persistence.${parts[1]}.${camelCase(tail)}`;
    }
  }

  if (parts[0] === "workspace") {
    // WORKSPACE_MAIN_PATH -> workspace.mainPath
    if (parts[1] === "main" && parts[2] === "path") {
      return "workspace.mainPath";
    }
  }

  if (parts[0] === "logger" || parts[0] === "log") {
    // LOGGER_MODE -> logger.mode
    // LOG_LEVEL -> logger.level
    const field = parts.slice(1).join("_");
    return `logger.${camelCase(field)}`;
  }

  // Default: convert to camelCase path
  return parts.map(camelCase).join(".");
}

/**
 * Convert snake_case to camelCase
 */
function camelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Set a nested configuration value using dot notation path
 */
function setConfigValue(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = config;

  // Navigate to the parent object
  for (let i = 0; i < parts.length - 1; i++) {
    const part = elementAt(parts, i, "environment setConfigValue parts");
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  // Set the final value with type conversion
  const finalKey = elementAt(parts, parts.length - 1, "environment setConfigValue finalKey");
  const fieldType = fieldTypes[path] || "string";
  const convertedValue = typeConverters[fieldType](value);

  current[finalKey] = convertedValue;
}

/**
 * Get environment configuration with metadata
 */
export function getEnvironmentConfiguration(): {
  config: PartialConfiguration;
  metadata: {
    loadedVariables: string[];
    mappings: Record<string, string>;
  };
} {
  const loadedVariables: string[] = [];
  const mappings: Record<string, string> = {};

  // Track which environment variables were loaded
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    if (process.env[envVar] !== undefined && process.env[envVar] !== "") {
      loadedVariables.push(envVar);
      mappings[envVar] = configPath;
    }
  }

  // Track MINSKY_ prefixed variables
  for (const envVar of Object.keys(process.env)) {
    if (envVar.startsWith("MINSKY_") && !(envVar in environmentMappings)) {
      // Skip hook-only env vars — see HOOK_ONLY_ENV_VARS docstring (mt#1644).
      // Stays in sync with loadEnvironmentConfiguration so metadata reporting
      // does not diverge from actual load behavior.
      if (HOOK_ONLY_ENV_VARS.has(envVar)) continue;

      const configPath = envVarToConfigPath(envVar);
      if (configPath && process.env[envVar] !== undefined && process.env[envVar] !== "") {
        loadedVariables.push(envVar);
        mappings[envVar] = configPath;
      }
    }
  }

  return {
    config: loadEnvironmentConfiguration(),
    metadata: {
      loadedVariables,
      mappings,
    },
  };
}

/**
 * Configuration source metadata
 */
export const environmentSourceMetadata = {
  name: "environment",
  description: "Environment variables configuration",
  priority: 100, // Highest priority
  required: false,
} as const;
