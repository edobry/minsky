/**
 * Knowledge Domain Types
 *
 * Core types for the knowledge base system, supporting document retrieval,
 * provider abstractions, and sync reporting across knowledge sources.
 */

/**
 * A document retrieved from a knowledge source
 */
export interface KnowledgeDocument {
  /** Unique identifier for the document within its source */
  id: string;
  /** Human-readable title of the document */
  title: string;
  /** Full text content of the document */
  content: string;
  /** URL or URI pointing to the original document */
  url: string;
  /** Optional parent document ID for hierarchical sources */
  parentId?: string;
  /** Timestamp of last modification */
  lastModified: Date;
  /** Arbitrary source-specific metadata */
  metadata: Record<string, unknown>;
}

/**
 * Options for listing documents from a knowledge source
 */
export interface ListOptions {
  /** Maximum depth to traverse in hierarchical sources */
  maxDepth?: number;
  /** Optional filter string or pattern */
  filter?: string;
  /** Only return documents modified since this date */
  modifiedSince?: Date;
}

/**
 * Interface for knowledge source providers
 *
 * Implementations handle the specifics of each knowledge platform
 * (Notion, Confluence, Google Docs, etc.)
 */
export interface KnowledgeSourceProvider {
  /** Unique type identifier for this provider */
  sourceType: string;
  /** Human-readable name for this provider instance */
  sourceName: string;

  /**
   * List all documents available from this source
   * Returns an async iterable to support streaming large document sets
   */
  listDocuments(options?: ListOptions): AsyncIterable<KnowledgeDocument>;

  /**
   * Fetch a single document by its ID
   */
  fetchDocument(id: string): Promise<KnowledgeDocument>;

  /**
   * Get documents that have changed since a given date
   */
  getChangedSince(since: Date, options?: ListOptions): AsyncIterable<KnowledgeDocument>;
}

/**
 * Configuration for a knowledge source connection
 */
export interface KnowledgeSourceConfig {
  /** Human-readable name for this knowledge source */
  name: string;
  /** Provider type (determines which connector to use) */
  type: "notion" | "confluence" | "google-docs";
  /** Authentication credentials for the source */
  auth: {
    /** Direct API token value (takes precedence over tokenEnvVar) */
    token?: string;
    /** Environment variable containing the API token */
    tokenEnvVar?: string;
    /** Optional environment variable for email (used by some providers) */
    emailEnvVar?: string;
    /**
     * Environment variable containing the JSON key for a Google service account.
     * Used by the google-docs provider as an alternative to OAuth tokens.
     */
    serviceAccountJsonEnvVar?: string;
  };
  /** Optional sync configuration */
  sync?: {
    /** When to sync: on-demand (explicit only), startup (session start), or daily */
    schedule?: "on-demand" | "startup" | "daily";
    /** Maximum depth to traverse */
    maxDepth?: number;
    /** Glob patterns for pages/documents to exclude */
    excludePatterns?: string[];
  };
  /**
   * Google Docs: Google Drive folder ID to walk recursively.
   * Mutually exclusive with `documentIds`.
   */
  driveFolderId?: string;
  /**
   * Google Docs: explicit list of Google Document IDs to sync.
   * Mutually exclusive with `driveFolderId`.
   */
  documentIds?: string[];
}

/**
 * Report produced after a sync operation
 */
export interface SyncReport {
  /** Name of the source that was synced */
  sourceName: string;
  /** Number of documents added */
  added: number;
  /** Number of documents updated */
  updated: number;
  /** Number of documents skipped (unchanged) */
  skipped: number;
  /** Number of documents removed */
  removed: number;
  /** Any errors encountered during sync */
  errors: Array<{ documentId?: string; message: string }>;
  /** Total duration in milliseconds */
  duration: number;
}
