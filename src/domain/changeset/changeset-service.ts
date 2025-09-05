/**
 * Unified Changeset Service
 *
 * Main orchestration service that provides unified changeset operations
 * across different VCS platforms using the adapter pattern.
 */

import type {
  Changeset,
  ChangesetListOptions,
  ChangesetSearchOptions,
  CreateChangesetOptions,
  CreateChangesetResult,
  MergeChangesetResult,
  ChangesetPlatform,
} from "./types";

import type {
  ChangesetAdapter,
  ChangesetAdapterFactory,
  ChangesetAdapterConfig,
  ChangesetDetails,
} from "./adapter-interface";

import { detectRepositoryBackendType } from "../session/repository-backend-detection";
import { MinskyError } from "../../errors/index";
import { log } from "../../utils/logger";

/**
 * Main changeset service that provides unified access to changesets
 * across different VCS platforms
 */
export class ChangesetService {
  private adapters = new Map<ChangesetPlatform, ChangesetAdapter>();
  private factories = new Map<ChangesetPlatform, ChangesetAdapterFactory>();

  constructor(
    private repositoryUrl: string,
    private workdir?: string
  ) {}

  /**
   * Register a changeset adapter factory for a platform
   */
  registerAdapterFactory(factory: ChangesetAdapterFactory): void {
    this.factories.set(factory.platform, factory);
    log.debug(`Registered changeset adapter factory for ${factory.platform}`);
  }

  /**
   * Get the appropriate adapter for this repository
   */
  private async getAdapter(): Promise<ChangesetAdapter> {
    // Determine platform based on existing repository backend detection
    const platform = this.detectPlatform();

    // Check if we already have an adapter for this platform
    if (this.adapters.has(platform)) {
      return this.adapters.get(platform)!;
    }

    // Create new adapter using factory
    const factory = this.factories.get(platform);
    if (!factory) {
      throw new MinskyError(`No changeset adapter factory registered for platform: ${platform}`);
    }

    const adapter = await factory.createAdapter(this.repositoryUrl);

    // Verify adapter is available
    if (!(await adapter.isAvailable())) {
      throw new MinskyError(
        `Changeset adapter for ${platform} is not available (check configuration)`
      );
    }

    this.adapters.set(platform, adapter);
    return adapter;
  }

  /**
   * Detect platform based on repository URL using existing detection logic
   */
  private detectPlatform(): ChangesetPlatform {
    if (this.repositoryUrl.includes("github.com")) {
      return "github-pr";
    } else if (this.repositoryUrl.includes("gitlab.com")) {
      return "gitlab-mr";
    } else if (this.repositoryUrl.includes("bitbucket.org")) {
      return "bitbucket-pr";
    } else if (this.repositoryUrl.includes("gerrit")) {
      return "gerrit-change";
    } else {
      // Local repository or unknown - use local git workflow
      return "local-git";
    }
  }

  /**
   * List changesets for this repository
   */
  async list(options?: ChangesetListOptions): Promise<Changeset[]> {
    const adapter = await this.getAdapter();
    return await adapter.list(options);
  }

  /**
   * Get a specific changeset by ID
   */
  async get(id: string): Promise<Changeset | null> {
    const adapter = await this.getAdapter();
    return await adapter.get(id);
  }

  /**
   * Search changesets across title, description, and comments
   */
  async search(options: ChangesetSearchOptions): Promise<Changeset[]> {
    const adapter = await this.getAdapter();
    return await adapter.search(options);
  }

  /**
   * Create a new changeset
   */
  async create(options: CreateChangesetOptions): Promise<CreateChangesetResult> {
    const adapter = await this.getAdapter();
    return await adapter.create(options);
  }

  /**
   * Update an existing changeset
   */
  async update(id: string, updates: Partial<CreateChangesetOptions>): Promise<Changeset> {
    const adapter = await this.getAdapter();
    return await adapter.update(id, updates);
  }

  /**
   * Merge a changeset into the target branch
   */
  async merge(
    id: string,
    options?: { deleteSourceBranch?: boolean }
  ): Promise<MergeChangesetResult> {
    const adapter = await this.getAdapter();
    return await adapter.merge(id, options);
  }

  /**
   * Approve a changeset (if platform supports separate approval workflow)
   */
  async approve(
    id: string,
    comment?: string
  ): Promise<{ success: boolean; reviewId: string } | null> {
    const adapter = await this.getAdapter();

    if (!adapter.approve) {
      // Platform doesn't support separate approval (merge is approval)
      return null;
    }

    return await adapter.approve(id, comment);
  }

  /**
   * Get detailed changeset information including diffs and files
   */
  async getDetails(id: string): Promise<ChangesetDetails> {
    const adapter = await this.getAdapter();
    return await adapter.getDetails(id);
  }

  /**
   * Check if the platform supports a specific feature
   */
  async supportsFeature(feature: import("./adapter-interface").ChangesetFeature): Promise<boolean> {
    const adapter = await this.getAdapter();
    return adapter.supportsFeature(feature);
  }

  /**
   * Get the current platform for this repository
   */
  async getPlatform(): Promise<ChangesetPlatform> {
    const adapter = await this.getAdapter();
    return adapter.platform;
  }

  /**
   * Get platform-specific changeset URL
   */
  async getChangesetUrl(id: string): Promise<string | null> {
    const changeset = await this.get(id);
    if (!changeset) return null;

    // Extract URL from platform-specific metadata
    switch (changeset.platform) {
      case "github-pr":
        return changeset.metadata.github?.htmlUrl || null;
      case "gitlab-mr":
        return changeset.metadata.gitlab?.webUrl || null;
      case "bitbucket-pr":
        return changeset.metadata.bitbucket?.url || null;
      case "gerrit-change":
        // Gerrit URLs are typically constructed
        return null;
      case "local-git":
        // Local git doesn't have URLs, return branch info
        return changeset.metadata.local?.prBranch || null;
      default:
        return null;
    }
  }

  /**
   * Get all reviews for a changeset across all platforms
   */
  async getReviews(id: string): Promise<import("./types").ChangesetReview[]> {
    const changeset = await this.get(id);
    return changeset?.reviews || [];
  }

  /**
   * Get all comments for a changeset
   */
  async getComments(id: string): Promise<import("./types").ChangesetComment[]> {
    const changeset = await this.get(id);
    return changeset?.comments || [];
  }
}

/**
 * Factory function to create a changeset service for a repository
 * Uses existing repository backend detection to determine the appropriate platform
 */
export async function createChangesetService(
  repositoryUrl: string,
  workdir?: string
): Promise<ChangesetService> {
  const service = new ChangesetService(repositoryUrl, workdir);

  // Auto-register available adapter factories
  await registerDefaultAdapterFactories(service);

  return service;
}

/**
 * Register default adapter factories for supported platforms
 */
async function registerDefaultAdapterFactories(service: ChangesetService): Promise<void> {
  // Dynamic imports to avoid circular dependencies

  try {
    const { GitHubChangesetAdapterFactory } = await import("./adapters/github-adapter");
    service.registerAdapterFactory(new GitHubChangesetAdapterFactory());
  } catch (error) {
    log.debug("GitHub changeset adapter not available", { error });
  }

  try {
    const { LocalGitChangesetAdapterFactory } = await import("./adapters/local-git-adapter");
    service.registerAdapterFactory(new LocalGitChangesetAdapterFactory());
  } catch (error) {
    log.debug("Local git changeset adapter not available", { error });
  }

  // Future: GitLab, Bitbucket, Gerrit adapters
  try {
    const { GitLabChangesetAdapterFactory } = await import("./adapters/gitlab-adapter");
    service.registerAdapterFactory(new GitLabChangesetAdapterFactory());
  } catch (error) {
    log.debug("GitLab changeset adapter not available (future implementation)", { error });
  }

  try {
    const { BitbucketChangesetAdapterFactory } = await import("./adapters/bitbucket-adapter");
    service.registerAdapterFactory(new BitbucketChangesetAdapterFactory());
  } catch (error) {
    log.debug("Bitbucket changeset adapter not available (future implementation)", { error });
  }
}
