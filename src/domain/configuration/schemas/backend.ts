/**
 * Backend Configuration Schema
 * 
 * Defines the schema for backend-related configuration including the main backend type,
 * backend-specific configurations, and detection rules for automatic backend selection.
 */

import { z } from "zod";
import { baseSchemas, enumSchemas } from "./base";

/**
 * Main backend configuration - which backend to use for tasks
 */
export const backendSchema = enumSchemas.backendType.default("markdown");

/**
 * GitHub Issues backend-specific configuration
 */
export const githubIssuesBackendConfigSchema = z.object({
  owner: baseSchemas.organizationName.optional(),
  repo: baseSchemas.repositoryName.optional(),
}).strict();

/**
 * Markdown backend-specific configuration (currently no specific config needed)
 */
export const markdownBackendConfigSchema = z.object({}).strict();

/**
 * JSON File backend-specific configuration (currently no specific config needed)
 */
export const jsonFileBackendConfigSchema = z.object({}).strict();

/**
 * Combined backend-specific configurations
 */
export const backendConfigSchema = z.object({
  "github-issues": githubIssuesBackendConfigSchema.optional(),
  markdown: markdownBackendConfigSchema.optional(),
  "json-file": jsonFileBackendConfigSchema.optional(),
}).strict().default({});

/**
 * Detection rule for automatic backend selection
 */
export const detectionRuleSchema = z.object({
  condition: enumSchemas.detectionCondition,
  backend: baseSchemas.nonEmptyString,
}).strict();

/**
 * Array of detection rules (evaluated in order)
 */
export const detectionRulesSchema = z.array(detectionRuleSchema).default([
  { condition: "tasks_md_exists", backend: "markdown" },
  { condition: "json_file_exists", backend: "json-file" },
  { condition: "always", backend: "markdown" },
]);

/**
 * Complete backend configuration combining all backend-related settings
 */
export const backendFullConfigSchema = z.object({
  // Main backend selection
  backend: backendSchema,
  
  // Backend-specific configurations
  backendConfig: backendConfigSchema,
  
  // Automatic detection rules
  detectionRules: detectionRulesSchema,
}).strict();

// Type exports
export type Backend = z.infer<typeof backendSchema>;
export type GitHubIssuesBackendConfig = z.infer<typeof githubIssuesBackendConfigSchema>;
export type MarkdownBackendConfig = z.infer<typeof markdownBackendConfigSchema>;
export type JsonFileBackendConfig = z.infer<typeof jsonFileBackendConfigSchema>;
export type BackendConfig = z.infer<typeof backendConfigSchema>;
export type DetectionRule = z.infer<typeof detectionRuleSchema>;
export type DetectionRules = z.infer<typeof detectionRulesSchema>;
export type BackendFullConfig = z.infer<typeof backendFullConfigSchema>;

/**
 * Validation functions for backend configuration
 */
export const backendValidation = {
  /**
   * Validate that a backend name is supported
   */
  isValidBackend: (backend: string): backend is Backend => {
    return ["markdown", "json-file", "github-issues"].includes(backend);
  },
  
  /**
   * Validate detection rule condition
   */
  isValidDetectionCondition: (condition: string): condition is z.infer<typeof enumSchemas.detectionCondition> => {
    return ["tasks_md_exists", "json_file_exists", "always"].includes(condition);
  },
  
  /**
   * Validate that GitHub Issues backend has required configuration
   */
  hasGitHubIssuesConfig: (backendConfig: BackendConfig, backend: Backend): boolean => {
    if (backend !== "github-issues") return true;
    return !!(backendConfig["github-issues"]?.owner && backendConfig["github-issues"]?.repo);
  },
} as const; 
