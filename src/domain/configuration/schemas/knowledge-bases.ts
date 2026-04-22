import { z } from "zod";

/**
 * Authentication configuration for a knowledge source.
 * At least one of `token`, `tokenEnvVar`, or `serviceAccountJsonEnvVar` must be provided.
 */
const knowledgeSourceAuthSchema = z
  .object({
    /** Direct API token value (takes precedence over tokenEnvVar) */
    token: z.string().optional(),
    /** Environment variable containing the API token */
    tokenEnvVar: z.string().optional(),
    /** Optional environment variable for email (used by some providers like Confluence) */
    emailEnvVar: z.string().optional(),
    /**
     * Environment variable containing the JSON key for a Google service account.
     * Used by the google-docs provider as an alternative to OAuth tokens.
     * The variable should contain the full JSON key file contents (as a string).
     */
    serviceAccountJsonEnvVar: z.string().optional(),
  })
  .refine(
    (data) =>
      data.token !== undefined ||
      data.tokenEnvVar !== undefined ||
      data.serviceAccountJsonEnvVar !== undefined,
    {
      message:
        "At least one of 'token', 'tokenEnvVar', or 'serviceAccountJsonEnvVar' must be provided",
    }
  );

/**
 * Sync schedule and behavior configuration
 */
const knowledgeSyncConfigSchema = z.object({
  /** When to sync: on-demand (explicit only), startup (session start), or daily */
  schedule: z.enum(["on-demand", "startup", "daily"]).default("on-demand"),
  /** Maximum depth to traverse in hierarchical sources */
  maxDepth: z.number().int().positive().optional(),
  /** Glob patterns for pages/documents to exclude from sync */
  excludePatterns: z.array(z.string()).optional(),
});

/**
 * Schema for a single knowledge base source entry.
 * Uses .passthrough() to allow type-specific fields (e.g., Notion workspace ID,
 * Confluence space key, Google Drive folder ID) without requiring them in the base schema.
 *
 * Google Docs provider supports two scope modes (mutually exclusive):
 *   - `driveFolderId`: Walk a Google Drive folder recursively
 *   - `documentIds`: Fetch specific documents by ID
 */
export const knowledgeBaseEntrySchema = z
  .object({
    /** Human-readable name for this knowledge source */
    name: z.string(),
    /** Provider type (determines which connector to use) */
    type: z.enum(["notion", "confluence", "google-docs"]),
    /** Authentication credentials */
    auth: knowledgeSourceAuthSchema,
    /** Optional sync behavior configuration */
    sync: knowledgeSyncConfigSchema.optional(),
    /**
     * Google Docs: Google Drive folder ID to walk recursively.
     * Mutually exclusive with `documentIds`.
     */
    driveFolderId: z.string().optional(),
    /**
     * Google Docs: explicit list of Google Document IDs to sync.
     * Mutually exclusive with `driveFolderId`.
     */
    documentIds: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Schema for the knowledgeBases config array
 */
export const knowledgeBasesConfigSchema = z.array(knowledgeBaseEntrySchema).default([]);

export type KnowledgeBaseEntry = z.infer<typeof knowledgeBaseEntrySchema>;
export type KnowledgeBasesConfig = z.infer<typeof knowledgeBasesConfigSchema>;
