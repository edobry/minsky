/**
 * Zod validation schemas for Minsky configuration
 * 
 * These schemas provide type-safe validation for configuration values
 * loaded from node-config, replacing the NodeConfigAdapter anti-pattern
 * with proper idiomatic validation.
 */

import { z } from 'zod';

// Base schemas for common types
const SessionDbBackendSchema = z.enum(['json', 'sqlite', 'postgres']);
const LoggerModeSchema = z.enum(['HUMAN', 'STRUCTURED', 'auto']);
const LoggerLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
const BackendTypeSchema = z.enum(['markdown', 'json-file', 'github-issues']);

// SessionDB configuration schema
export const SessionDbConfigSchema = z.object({
  backend: SessionDbBackendSchema,
  baseDir: z.string().optional().nullable(),
  dbPath: z.string().optional().nullable(),
  connectionString: z.string().optional().nullable(),
});

// AI provider configuration schema
export const AIProviderConfigSchema = z.object({
  api_key: z.string().optional(),
  api_key_file: z.string().optional(),
  enabled: z.boolean().default(true),
  default_model: z.string().optional(),
  base_url: z.string().optional(),
  models: z.array(z.string()).default([]),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
});

// AI configuration schema
export const AIConfigSchema = z.object({
  default_provider: z.string().optional(),
  providers: z.object({
    openai: AIProviderConfigSchema.optional(),
    anthropic: AIProviderConfigSchema.optional(),
    google: AIProviderConfigSchema.optional(),
    cohere: AIProviderConfigSchema.optional(),
    mistral: AIProviderConfigSchema.optional(),
  }).optional(),
});

// GitHub configuration schema
export const GitHubConfigSchema = z.object({
  token: z.string().optional(),
  token_file: z.string().optional(),
});

// Logger configuration schema
export const LoggerConfigSchema = z.object({
  mode: LoggerModeSchema.default('auto'),
  level: LoggerLevelSchema.default('info'),
  enableAgentLogs: z.boolean().default(false),
});

// Backend detection rule schema
export const DetectionRuleSchema = z.object({
  condition: z.string(),
  backend: BackendTypeSchema,
});

// Backend configuration schema
export const BackendConfigSchema = z.record(z.string(), z.any());

// Main configuration schema
export const ConfigSchema = z.object({
  backend: BackendTypeSchema.default('markdown'),
  backendConfig: BackendConfigSchema.default({}),
  detectionRules: z.array(DetectionRuleSchema).default([]),
  sessiondb: SessionDbConfigSchema,
  ai: AIConfigSchema.optional(),
  github: GitHubConfigSchema.optional(),
  logger: LoggerConfigSchema.default({
    mode: 'auto',
    level: 'info',
    enableAgentLogs: false,
  }),
});

// Repository configuration schema
export const RepositoryConfigSchema = z.object({
  version: z.number(),
  sessiondb: z.object({
    backend: SessionDbBackendSchema,
    base_dir: z.string().optional(),
    db_path: z.string().optional(),
    connection_string: z.string().optional(),
  }).optional(),
  ai: AIConfigSchema.optional(),
  github: GitHubConfigSchema.optional(),
  logger: LoggerConfigSchema.optional(),
});

// Global user configuration schema
export const GlobalUserConfigSchema = z.object({
  version: z.number(),
  sessiondb: z.object({
    base_dir: z.string().optional(),
    db_path: z.string().optional(),
    connection_string: z.string().optional(),
  }).optional(),
  ai: AIConfigSchema.optional(),
  github: GitHubConfigSchema.optional(),
  logger: LoggerConfigSchema.optional(),
});

// Validation result types
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  value?: any;
}

export interface ValidationWarning {
  path: string;
  message: string;
  value?: any;
}

// Validation functions
export function validateConfig(config: any): ValidationResult {
  const result = ConfigSchema.safeParse(config);
  
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  
  const errors: ValidationError[] = result.error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
    value: issue.code,
  }));
  
  return { valid: false, errors, warnings: [] };
}

export function validateRepositoryConfig(config: any): ValidationResult {
  const result = RepositoryConfigSchema.safeParse(config);
  
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  
  const errors: ValidationError[] = result.error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
    value: issue.code,
  }));
  
  return { valid: false, errors, warnings: [] };
}

export function validateGlobalUserConfig(config: any): ValidationResult {
  const result = GlobalUserConfigSchema.safeParse(config);
  
  if (result.success) {
    return { valid: true, errors: [], warnings: [] };
  }
  
  const errors: ValidationError[] = result.error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
    value: issue.code,
  }));
  
  return { valid: false, errors, warnings: [] };
}

// Type exports from schemas
export type SessionDbConfig = z.infer<typeof SessionDbConfigSchema>;
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type AIProviderConfig = z.infer<typeof AIProviderConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type LoggerConfig = z.infer<typeof LoggerConfigSchema>;
export type DetectionRule = z.infer<typeof DetectionRuleSchema>;
export type BackendConfig = z.infer<typeof BackendConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type GlobalUserConfig = z.infer<typeof GlobalUserConfigSchema>; 
