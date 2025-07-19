/**
 * GitHub Configuration Schema
 * 
 * Defines the schema for GitHub-related configuration including authentication tokens,
 * organization settings, and repository configuration for GitHub Issues backend.
 */

import { z } from "zod";
import { baseSchemas } from "./base";

/**
 * GitHub authentication token configuration
 */
export const githubTokenSchema = z.object({
  // Direct token value (for environment variable or direct configuration)
  token: baseSchemas.optionalNonEmptyString,
  
  // Path to file containing the token
  tokenFile: baseSchemas.optionalNonEmptyString,
}).strict().optional();

/**
 * GitHub organization/repository configuration
 */
export const githubRepoConfigSchema = z.object({
  // GitHub organization or user name
  organization: baseSchemas.organizationName.optional(),
  
  // Default repository name for GitHub Issues backend
  repository: baseSchemas.repositoryName.optional(),
  
  // Base URL for GitHub API (for GitHub Enterprise)
  baseUrl: baseSchemas.url.optional(),
}).strict().optional();

/**
 * Complete GitHub configuration
 */
export const githubConfigSchema = z.object({
  // Authentication token (from environment variable or file)
  token: baseSchemas.optionalNonEmptyString,
  
  // Path to token file
  tokenFile: baseSchemas.optionalNonEmptyString,
  
  // Organization name
  organization: baseSchemas.organizationName.optional(),
  
  // Repository name  
  repository: baseSchemas.repositoryName.optional(),
  
  // GitHub API base URL (for GitHub Enterprise)
  baseUrl: baseSchemas.url.optional(),
}).strict().default({});

// Type exports
export type GitHubTokenConfig = z.infer<typeof githubTokenSchema>;
export type GitHubRepoConfig = z.infer<typeof githubRepoConfigSchema>;
export type GitHubConfig = z.infer<typeof githubConfigSchema>;

/**
 * Validation functions for GitHub configuration
 */
export const githubValidation = {
  /**
   * Check if GitHub token is available (either directly or via file)
   */
  hasToken: (config: GitHubConfig): boolean => {
    return !!(config?.token || config?.tokenFile);
  },
  
  /**
   * Check if GitHub repository configuration is complete
   */
  hasRepoConfig: (config: GitHubConfig): boolean => {
    return !!(config && config.organization && config.repository);
  },
  
  /**
   * Get the effective token source (for credential resolution)
   */
  getTokenSource: (config: GitHubConfig): "environment" | "file" | "none" => {
    if (config?.token) return "environment";
    if (config?.tokenFile) return "file";
    return "none";
  },
  
  /**
   * Get the effective GitHub API base URL
   */
  getApiBaseUrl: (config: GitHubConfig): string => {
    return config?.baseUrl || "https://api.github.com";
  },
  
  /**
   * Validate GitHub repository identifier format
   */
  isValidRepoIdentifier: (identifier: string): boolean => {
    // Format: owner/repo
    const parts = identifier.split("/");
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  },
  
  /**
   * Parse repository identifier into owner and repo
   */
  parseRepoIdentifier: (identifier: string): { owner: string; repo: string } | null => {
    if (!githubValidation.isValidRepoIdentifier(identifier)) {
      return null;
    }
    
    const [owner, repo] = identifier.split("/");
    return { owner: owner!, repo: repo! };
  },
  
  /**
   * Format repository configuration as identifier
   */
  formatRepoIdentifier: (config: GitHubConfig): string | null => {
    if (!config?.organization || !config?.repository) {
      return null;
    }
    
    return `${config.organization}/${config.repository}`;
  },
} as const;

/**
 * Environment variable mapping for GitHub configuration
 */
export const githubEnvMapping = {
  // Standard GitHub token environment variables
  GITHUB_TOKEN: "github.token",
  GH_TOKEN: "github.token", // Fallback for GitHub CLI
  
  // Organization and repository
  GITHUB_ORGANIZATION: "github.organization", 
  GITHUB_REPOSITORY: "github.repository",
  
  // GitHub Enterprise
  GITHUB_BASE_URL: "github.baseUrl",
  GITHUB_API_URL: "github.baseUrl",
} as const; 
