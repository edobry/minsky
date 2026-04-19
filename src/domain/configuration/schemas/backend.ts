/**
 * Backend Configuration Schema
 *
 * Defines the schema for backend-related configuration including the main backend type,
 * backend-specific configurations, and detection rules for automatic backend selection.
 */

import { z } from "zod";
import { baseSchemas, enumSchemas } from "./base";
import { TaskBackend } from "../backend-detection";

/**
 * Main backend configuration - which backend to use for tasks
 *
 * @deprecated Use `tasks.backend` instead. This property is kept for backward
 * compatibility with MINSKY_BACKEND environment variable but will be removed
 * in a future version.
 *
 * Note: No default value since this is deprecated - only shows if explicitly set.
 */
export const backendSchema = enumSchemas.backendType.optional();

/**
 * GitHub Issues backend-specific configuration
 */
export const githubIssuesBackendConfigSchema = z.strictObject({
  owner: baseSchemas.organizationName.optional(),
  repo: baseSchemas.repositoryName.optional(),
});

/**
 * Combined backend-specific configurations
 */
export const backendConfigSchema = z
  .strictObject({
    "github-issues": githubIssuesBackendConfigSchema.optional(),
  })
  .default({});

/**
 * Complete backend configuration combining all backend-related settings
 */
export const backendFullConfigSchema = z.strictObject({
  // Main backend selection
  backend: backendSchema,

  // Backend-specific configurations
  backendConfig: backendConfigSchema,
});

/**
 * Repository GitHub-specific configuration
 */
export const repositoryGitHubConfigSchema = z.object({
  owner: z.string(),
  repo: z.string(),
});

/**
 * Repository backend configuration
 *
 * Stores the project-level repository backend type and associated settings,
 * detected once at `minsky init` and stored in .minsky/config.yaml.
 */
export const repositoryConfigSchema = z.looseObject({
  backend: enumSchemas.repoBackendType.optional(),
  url: z.string().optional(),
  github: repositoryGitHubConfigSchema.optional(),
});

// Type exports
export type Backend = z.infer<typeof backendSchema>;
export type GitHubIssuesBackendConfig = z.infer<typeof githubIssuesBackendConfigSchema>;
export type BackendConfig = z.infer<typeof backendConfigSchema>;
export type BackendFullConfig = z.infer<typeof backendFullConfigSchema>;
export type RepositoryGitHubConfig = z.infer<typeof repositoryGitHubConfigSchema>;
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

/**
 * Validation functions for backend configuration
 */
export const backendValidation = {
  /**
   * Validate that a backend name is supported
   */
  isValidBackend: (backend: string): backend is NonNullable<Backend> => {
    return Object.values(TaskBackend).includes(backend as TaskBackend);
  },

  /**
   * Validate that GitHub Issues backend has required configuration
   */
  hasGitHubIssuesConfig: (backendConfig: BackendConfig, backend: Backend): boolean => {
    if (backend !== TaskBackend.GITHUB_ISSUES) return true;
    return !!(backendConfig["github-issues"]?.owner && backendConfig["github-issues"]?.repo);
  },
} as const;
