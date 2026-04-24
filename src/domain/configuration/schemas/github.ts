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
export const githubTokenSchema = z
  .strictObject({
    // Direct token value (for environment variable or direct configuration)
    token: baseSchemas.optionalNonEmptyString,

    // Path to file containing the token
    tokenFile: baseSchemas.optionalNonEmptyString,
  })
  .optional();

/**
 * GitHub organization/repository configuration
 */
export const githubRepoConfigSchema = z
  .strictObject({
    // GitHub organization or user name
    organization: baseSchemas.organizationName.optional(),

    // Default repository name for GitHub Issues backend
    repository: baseSchemas.repositoryName.optional(),

    // Base URL for GitHub API (for GitHub Enterprise)
    baseUrl: baseSchemas.url.optional(),
  })
  .optional();

/**
 * GitHub App service account configuration
 */
export const githubServiceAccountSchema = z
  .object({
    // Discriminant for future multi-backend support (GitLab App, etc.). Today there's
    // only one valid value, so default it — this lets env-var-only configs work without
    // requiring an explicit MINSKY_APP_TYPE=github-app setting. `docs/github-app-bot-setup.md`
    // already claims this is auto-inferred; this default makes the claim actually true.
    type: z.literal("github-app").default("github-app"),
    appId: z.number(),
    /** Path to the PEM private key file (traditional local-deploy path). */
    privateKeyFile: z.string().optional(),
    /** Raw PEM content (env-var path, e.g., from MINSKY_GITHUB_APP_PRIVATE_KEY). */
    privateKey: z.string().optional(),
    installationId: z.number(),
  })
  .refine((data) => !!(data.privateKey || data.privateKeyFile), {
    message:
      "GitHub App service account requires either privateKey (env var) or privateKeyFile (file path)",
    path: ["privateKey"],
  })
  .optional();

/**
 * Complete GitHub configuration
 */
export const githubConfigSchema = z
  .strictObject({
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

    // GitHub App service account configuration
    serviceAccount: githubServiceAccountSchema,
  })
  .default({});

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
  getTokenSource: (config: GitHubConfig): "env" | "file" | "none" => {
    if (config?.token) return "env";
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
    return parts.length === 2 && (parts[0]?.length ?? 0) > 0 && (parts[1]?.length ?? 0) > 0;
  },

  /**
   * Parse repository identifier into owner and repo
   */
  parseRepoIdentifier: (identifier: string): { owner: string; repo: string } | null => {
    if (!githubValidation.isValidRepoIdentifier(identifier)) {
      return null;
    }

    const [owner, repo] = identifier.split("/");
    return { owner: owner ?? "", repo: repo ?? "" };
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

  // GitHub App private key (env-var / hosted-deploy path)
  MINSKY_GITHUB_APP_PRIVATE_KEY: "github.serviceAccount.privateKey",
} as const;
