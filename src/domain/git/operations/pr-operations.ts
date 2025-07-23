/**
 * Git PR Operations
 * 
 * Operations for pull request related functionality.
 * Extracted from git.ts as part of modularization effort.
 */
import { BaseGitOperation, type GitOperationDependencies, type BaseGitOperationParams } from "./base-git-operation";
import { type GitServiceInterface } from "../types";
import { type PreparePrResult, type MergePrResult } from "../types";

/**
 * Parameters for create pull request operation
 */
interface CreatePullRequestParams extends BaseGitOperationParams {
  branch?: string;
  taskId?: string;
  noStatusUpdate?: boolean;
}

/**
 * Parameters for prepare PR operation
 */
interface PreparePrParams extends BaseGitOperationParams {
  baseBranch?: string;
  title?: string;
  body?: string;
  branchName?: string;
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
  { markdown: string; statusUpdateResult?: any }
> {
  getOperationName(): string {
    return "create pull request";
  }

  async executeOperation(
    params: CreatePullRequestParams,
    gitService: GitServiceInterface
  ): Promise<{ markdown: string; statusUpdateResult?: any }> {
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

  protected getAdditionalLogContext(params: CreatePullRequestParams): Record<string, any> {
    return {
      branch: params.branch,
      taskId: params.taskId,
      noStatusUpdate: params.noStatusUpdate,
    };
  }
}

/**
 * Prepare PR operation
 */
export class PreparePrOperation extends BaseGitOperation<PreparePrParams, PreparePrResult> {
  getOperationName(): string {
    return "prepare pull request";
  }

  async executeOperation(
    params: PreparePrParams,
    gitService: GitServiceInterface
  ): Promise<PreparePrResult> {
    const result = await gitService.preparePr({
      session: params.session,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      title: params.title,
      body: params.body,
      branchName: params.branchName,
      debug: params.debug,
    });
    return result;
  }

  protected getAdditionalLogContext(params: PreparePrParams): Record<string, any> {
    return {
      baseBranch: params.baseBranch,
      title: params.title,
      branchName: params.branchName,
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
    const result = await gitService.mergePr({
      prBranch: params.prBranch,
      repoPath: params.repo,
      baseBranch: params.baseBranch,
      session: params.session,
    });
    return result;
  }

  protected getAdditionalLogContext(params: MergePrParams): Record<string, any> {
    return {
      prBranch: params.prBranch,
      baseBranch: params.baseBranch,
    };
  }
}

/**
 * Factory functions for creating PR operations
 */
export const createCreatePullRequestOperation = (deps?: GitOperationDependencies) =>
  new CreatePullRequestOperation(deps);

export const createPreparePrOperation = (deps?: GitOperationDependencies) =>
  new PreparePrOperation(deps);

export const createMergePrOperation = (deps?: GitOperationDependencies) =>
  new MergePrOperation(deps);