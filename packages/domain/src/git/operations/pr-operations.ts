/**
 * Git PR Operations
 *
 * Operations for pull request related functionality.
 * Extracted from git.ts as part of modularization effort.
 */
import {
  BaseGitOperation,
  type GitOperationDependencies,
  type BaseGitOperationParams,
} from "./base-git-operation";
import { type GitServiceInterface } from "../types";
import { type MergePrResult, type PrResult } from "../types";

/**
 * Parameters for create pull request operation
 */
interface CreatePullRequestParams extends BaseGitOperationParams {
  branch?: string;
  taskId?: string;
  noStatusUpdate?: boolean;
}

/**
 * Parameters for merge PR operation
 */
interface MergePrParams extends BaseGitOperationParams {
  prBranch: string;
  baseBranch?: string;
}

/**
 * Create pull request operation
 */
export class CreatePullRequestOperation extends BaseGitOperation<
  CreatePullRequestParams,
  PrResult
> {
  getOperationName(): string {
    return "create pull request";
  }

  async executeOperation(
    params: CreatePullRequestParams,
    gitService: GitServiceInterface
  ): Promise<PrResult> {
    if (!gitService.pr) {
      throw new Error("Git service does not support pull request creation");
    }
    const result = await gitService.pr({
      session: params.session,
      repoPath: params.repo,
      branch: params.branch,
      taskId: params.taskId,
      debug: params.debug,
      noStatusUpdate: params.noStatusUpdate,
    });
    return result;
  }

  protected getAdditionalLogContext(params: CreatePullRequestParams): Record<string, unknown> {
    return {
      branch: params.branch,
      taskId: params.taskId,
      noStatusUpdate: params.noStatusUpdate,
    };
  }
}

/**
 * Merge PR operation
 */
export class MergePrOperation extends BaseGitOperation<MergePrParams, MergePrResult> {
  getOperationName(): string {
    return "merge pull request";
  }

  async executeOperation(
    params: MergePrParams,
    gitService: GitServiceInterface
  ): Promise<MergePrResult> {
    if (!gitService.mergePr) {
      throw new Error("Git service does not support pull request merging");
    }
    const result = await gitService.mergePr({
      prBranch: params.prBranch,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      session: params.session,
    });
    return result;
  }

  protected getAdditionalLogContext(params: MergePrParams): Record<string, unknown> {
    return {
      prBranch: params.prBranch,
      baseBranch: params.baseBranch,
    };
  }
}

/**
 * Factory functions for creating PR operations
 */
export const createCreatePullRequestOperation = (deps?: GitOperationDependencies) => {
  if (!deps)
    throw new Error("GitOperationDependencies required for createCreatePullRequestOperation");
  return new CreatePullRequestOperation(deps);
};

export const createMergePrOperation = (deps?: GitOperationDependencies) => {
  if (!deps) throw new Error("GitOperationDependencies required for createMergePrOperation");
  return new MergePrOperation(deps);
};
