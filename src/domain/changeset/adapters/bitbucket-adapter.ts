/**
 * Bitbucket Changeset Adapter (Future Implementation)
 *
 * Placeholder implementation for Bitbucket Pull Requests.
 * This shows the extensible architecture for additional platforms.
 */

import type {
  ChangesetAdapter,
  ChangesetAdapterFactory,
  ChangesetDetails,
  ChangesetFeature,
} from "../adapter-interface";

import type {
  Changeset,
  ChangesetListOptions,
  ChangesetSearchOptions,
  CreateChangesetOptions,
  CreateChangesetResult,
  MergeChangesetResult,
  ChangesetPlatform,
} from "../types";

import { MinskyError } from "../../../errors/index";

/**
 * Bitbucket changeset adapter for Pull Requests
 * TODO: Implement using Bitbucket API
 */
export class BitbucketChangesetAdapter implements ChangesetAdapter {
  readonly platform: ChangesetPlatform = "bitbucket-pr";
  readonly name = "Bitbucket Pull Requests";

  constructor(
    private repositoryUrl: string,
    private config?: { token?: string; username?: string }
  ) {}

  async isAvailable(): Promise<boolean> {
    // TODO: Implement Bitbucket API availability check
    return false; // Not implemented yet
  }

  async list(options?: ChangesetListOptions): Promise<Changeset[]> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async get(id: string): Promise<Changeset | null> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async search(options: ChangesetSearchOptions): Promise<Changeset[]> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async create(options: CreateChangesetOptions): Promise<CreateChangesetResult> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async update(id: string, updates: Partial<CreateChangesetOptions>): Promise<Changeset> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async merge(
    id: string,
    options?: { deleteSourceBranch?: boolean }
  ): Promise<MergeChangesetResult> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  async getDetails(id: string): Promise<ChangesetDetails> {
    throw new MinskyError("Bitbucket changeset adapter not implemented yet");
  }

  supportsFeature(feature: ChangesetFeature): boolean {
    // Bitbucket PR features (when implemented)
    switch (feature) {
      case "approval_workflow":
      case "file_comments":
      case "auto_merge":
      case "branch_protection":
      case "assignee_management":
        return true; // Bitbucket supports these features
      case "draft_changesets":
      case "suggested_changes":
      case "status_checks":
      case "label_management":
      case "milestone_tracking":
        return false; // Not supported or different in Bitbucket
      default:
        return false;
    }
  }
}

/**
 * Factory for creating Bitbucket changeset adapters
 */
export class BitbucketChangesetAdapterFactory implements ChangesetAdapterFactory {
  readonly platform: ChangesetPlatform = "bitbucket-pr";

  canHandle(repositoryUrl: string): boolean {
    return repositoryUrl.includes("bitbucket.org") || repositoryUrl.includes("bitbucket.");
  }

  async createAdapter(repositoryUrl: string, config?: any): Promise<ChangesetAdapter> {
    return new BitbucketChangesetAdapter(repositoryUrl, config);
  }
}
