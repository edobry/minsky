/**
 * Repository Backend Integration for Changeset Abstraction
 *
 * Provides integration layer between existing repository backends
 * and the new changeset abstraction system.
 */

import { ChangesetService, createChangesetService } from "./changeset-service";
import type { RepositoryBackend } from "../repository/index";
import type { Changeset, CreateChangesetOptions } from "./types";
import { detectRepositoryBackendType } from "../session/repository-backend-detection";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Enhanced repository backend that includes changeset operations
 * This extends existing repository backends with changeset abstraction
 */
export interface ChangesetAwareRepositoryBackend extends RepositoryBackend {
  /** Access to changeset service for this repository */
  getChangesetService(): Promise<ChangesetService>;

  /** List changesets for this repository */
  listChangesets(options?: import("./types").ChangesetListOptions): Promise<Changeset[]>;

  /** Get a specific changeset */
  getChangeset(id: string): Promise<Changeset | null>;

  /** Search changesets */
  searchChangesets(
    query: string,
    options?: Partial<import("./types").ChangesetSearchOptions>
  ): Promise<Changeset[]>;

  /** Create changeset using abstraction layer */
  createChangesetAbstraction(options: CreateChangesetOptions): Promise<Changeset>;
}

/**
 * Mixin function to enhance existing repository backends with changeset capabilities
 */
export function withChangesetSupport<T extends RepositoryBackend>(
  repositoryBackend: T,
  repositoryUrl: string,
  workdir?: string
): T & ChangesetAwareRepositoryBackend {
  let changesetService: ChangesetService | null = null;

  const enhanced = repositoryBackend as T & ChangesetAwareRepositoryBackend;

  // Add changeset service getter
  enhanced.getChangesetService = async (): Promise<ChangesetService> => {
    if (!changesetService) {
      changesetService = await createChangesetService(repositoryUrl, workdir);
    }
    return changesetService;
  };

  // Add changeset operations
  enhanced.listChangesets = async (options?) => {
    const service = await enhanced.getChangesetService();
    return await service.list(options);
  };

  enhanced.getChangeset = async (id: string) => {
    const service = await enhanced.getChangesetService();
    return await service.get(id);
  };

  enhanced.searchChangesets = async (query: string, options?) => {
    const service = await enhanced.getChangesetService();
    return await service.search({ query, ...options });
  };

  enhanced.createChangesetAbstraction = async (options: CreateChangesetOptions) => {
    const service = await enhanced.getChangesetService();
    const result = await service.create(options);
    return result.changeset;
  };

  return enhanced;
}

/**
 * Factory function to create changeset-aware repository backends
 */
export async function createChangesetAwareRepositoryBackend(
  repositoryUrl: string,
  workdir?: string
): Promise<ChangesetAwareRepositoryBackend> {
  try {
    // Use existing repository backend detection and creation
    const backendType = detectRepositoryBackendType(workdir || repositoryUrl);

    const config = {
      type: backendType,
      repoUrl: repositoryUrl,
    };

    // Add platform-specific configuration
    if (backendType === "github") {
      const githubInfo = await import("../session/repository-backend-detection").then((mod) =>
        mod.extractGitHubInfoFromUrl(repositoryUrl)
      );

      if (githubInfo) {
        config.github = {
          owner: githubInfo.owner,
          repo: githubInfo.repo,
        };
      }
    }

    // Create base repository backend
    const { createRepositoryBackend } = await import("../repository/index");
    const repositoryBackend = await createRepositoryBackend(config);

    // Enhance with changeset support
    return withChangesetSupport(repositoryBackend, repositoryUrl, workdir);
  } catch (error) {
    throw new MinskyError(
      `Failed to create changeset-aware repository backend: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Service for managing changesets across multiple repositories
 * Useful for multi-repo scenarios or repository indexing
 */
export class MultiRepositoryChangesetService {
  private services = new Map<string, ChangesetService>();

  /**
   * Get or create changeset service for a repository
   */
  async getServiceForRepository(
    repositoryUrl: string,
    workdir?: string
  ): Promise<ChangesetService> {
    const key = `${repositoryUrl}:${workdir || ""}`;

    if (!this.services.has(key)) {
      const service = await createChangesetService(repositoryUrl, workdir);
      this.services.set(key, service);
    }

    return this.services.get(key)!;
  }

  /**
   * Search changesets across all registered repositories
   */
  async searchAll(
    query: string,
    options?: Partial<import("./types").ChangesetSearchOptions>
  ): Promise<
    Array<{
      repository: string;
      changesets: Changeset[];
    }>
  > {
    const results: Array<{ repository: string; changesets: Changeset[] }> = [];

    for (const [key, service] of this.services) {
      try {
        const repositoryUrl = key.split(":")[0];
        const changesets = await service.search({ query, ...options });

        if (changesets.length > 0) {
          results.push({
            repository: repositoryUrl,
            changesets,
          });
        }
      } catch (error) {
        log.debug(`Failed to search changesets in ${key}`, { error: getErrorMessage(error) });
        // Continue with other repositories
      }
    }

    return results;
  }

  /**
   * List all changesets across repositories
   */
  async listAll(options?: import("./types").ChangesetListOptions): Promise<
    Array<{
      repository: string;
      changesets: Changeset[];
    }>
  > {
    const results: Array<{ repository: string; changesets: Changeset[] }> = [];

    for (const [key, service] of this.services) {
      try {
        const repositoryUrl = key.split(":")[0];
        const changesets = await service.list(options);

        results.push({
          repository: repositoryUrl,
          changesets,
        });
      } catch (error) {
        log.debug(`Failed to list changesets in ${key}`, { error: getErrorMessage(error) });
        // Continue with other repositories
      }
    }

    return results;
  }

  /**
   * Register a repository for multi-repo changeset operations
   */
  async addRepository(repositoryUrl: string, workdir?: string): Promise<void> {
    await this.getServiceForRepository(repositoryUrl, workdir);
    log.debug(`Added repository to multi-repo changeset service: ${repositoryUrl}`);
  }

  /**
   * Remove a repository from tracking
   */
  removeRepository(repositoryUrl: string, workdir?: string): void {
    const key = `${repositoryUrl}:${workdir || ""}`;
    this.services.delete(key);
    log.debug(`Removed repository from multi-repo changeset service: ${repositoryUrl}`);
  }
}

/**
 * Global multi-repository changeset service instance
 * Useful for indexing and searching across multiple repositories
 */
export const globalChangesetService = new MultiRepositoryChangesetService();
