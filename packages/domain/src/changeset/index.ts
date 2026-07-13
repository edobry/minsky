/**
 * Changeset Domain - Unified Abstraction for VCS Changesets
 *
 * Provides a platform-agnostic interface for VCS changeset concepts. Only
 * GitHub Pull Requests are currently implemented (mt#2613); the shared types
 * remain platform-agnostic to keep the door open for future backends.
 */

// Core types and interfaces
export * from "./types";
export * from "./adapter-interface";

// Main service
import { ChangesetService, createChangesetService } from "./changeset-service";
export { ChangesetService, createChangesetService };

// Platform adapter
export { GitHubChangesetAdapter, GitHubChangesetAdapterFactory } from "./adapters/github-adapter";

/**
 * Factory function to create a changeset service with auto-detection
 * Uses existing repository backend detection to determine platform
 */
export async function createChangesetServiceFromRepository(
  repositoryUrl: string,
  workdir?: string
): Promise<ChangesetService> {
  return await createChangesetService(repositoryUrl, workdir);
}
