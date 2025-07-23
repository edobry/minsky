/**
 * Backend capabilities interface for capability discovery
 * Defines what metadata and operations each backend supports
 */
export interface BackendCapabilities {
  // Core operations
  supportsTaskCreation: boolean;
  supportsTaskUpdate: boolean;
  supportsTaskDeletion: boolean;

  // Essential metadata support
  supportsStatus: boolean;

  // Structural metadata (Tasks #238, #239)
  supportsSubtasks: boolean;
  supportsDependencies: boolean;

  // Provenance metadata
  supportsOriginalRequirements: boolean;
  supportsAiEnhancementTracking: boolean;

  // Query capabilities
  supportsMetadataQuery: boolean;
  supportsFullTextSearch: boolean;

  // Update mechanism
  requiresSpecialWorkspace: boolean;
  supportsTransactions: boolean;
  supportsRealTimeSync: boolean;
  
  // Hybrid backend support (Task #315)
  isHybridBackend: boolean;
  specStorageType?: string; // e.g., "github-issues", "markdown-files"
  metadataStorageType?: string; // e.g., "sqlite", "postgresql", "json"
}