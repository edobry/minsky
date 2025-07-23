/**
 * Git Basic Operations
 * 
 * Operations for basic git functionality (clone, branch, push, commit).
 * Extracted from git.ts as part of modularization effort.
 */
import { BaseGitOperation, type GitOperationDependencies, type BaseGitOperationParams } from "./base-git-operation";
import { type GitServiceInterface, type CloneResult, type BranchResult, type PushResult } from "../types";

/**
 * Parameters for clone operation
 */
interface CloneParams extends BaseGitOperationParams {
  url: string;
  workdir: string;
  branch?: string;
}

/**
 * Parameters for branch operation
 */
interface BranchParams extends BaseGitOperationParams {
  name: string;
}

/**
 * Parameters for push operation
 */
interface PushParams extends BaseGitOperationParams {
  remote?: string;
  force?: boolean;
}

/**
 * Parameters for commit operation
 */
interface CommitParams extends BaseGitOperationParams {
  message: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}

/**
 * Clone repository operation
 */
export class CloneOperation extends BaseGitOperation<CloneParams, CloneResult> {
  getOperationName(): string {
    return "clone repository";
  }

  async executeOperation(
    params: CloneParams,
    gitService: GitServiceInterface
  ): Promise<CloneResult> {
    const result = await gitService.clone({
      repoUrl: params.url,
      workdir: params.workdir,
      session: params.session,
      branch: params.branch,
    });
    return result;
  }

  protected getAdditionalLogContext(params: CloneParams): Record<string, any> {
    return {
      url: params.url,
      workdir: params.workdir,
      branch: params.branch,
    };
  }
}

/**
 * Create branch operation
 */
export class BranchOperation extends BaseGitOperation<BranchParams, BranchResult> {
  getOperationName(): string {
    return "create branch";
  }

  async executeOperation(
    params: BranchParams,
    gitService: GitServiceInterface
  ): Promise<BranchResult> {
    if (!params.session) {
      throw new Error("Session parameter is required for branch operation");
    }

    const result = await gitService.branch({
      session: params.session,
      branch: params.name,
    });
    return result;
  }

  protected getAdditionalLogContext(params: BranchParams): Record<string, any> {
    return {
      name: params.name,
    };
  }
}

/**
 * Push changes operation
 */
export class PushOperation extends BaseGitOperation<PushParams, PushResult> {
  getOperationName(): string {
    return "push changes";
  }

  async executeOperation(
    params: PushParams,
    gitService: GitServiceInterface
  ): Promise<PushResult> {
    const result = await gitService.push({
      session: params.session,
      repoPath: params.repo,
      remote: params.remote,
      force: params.force,
      debug: params.debug,
    });
    return result;
  }

  protected getAdditionalLogContext(params: PushParams): Record<string, any> {
    return {
      remote: params.remote,
      force: params.force,
    };
  }
}

/**
 * Commit changes operation
 */
export class CommitOperation extends BaseGitOperation<
  CommitParams,
  { commitHash: string; message: string }
> {
  getOperationName(): string {
    return "commit changes";
  }

  async executeOperation(
    params: CommitParams,
    gitService: GitServiceInterface
  ): Promise<{ commitHash: string; message: string }> {
    // Handle staging if not disabled
    if (!params.noStage) {
      if (params.all) {
        await gitService.stageAll(params.repo);
      } else {
        await gitService.stageModified(params.repo);
      }
    }

    // Commit changes
    const commitHash = await gitService.commit(
      params.message,
      params.repo,
      params.amend
    );

    return {
      commitHash,
      message: params.message,
    };
  }

  protected getAdditionalLogContext(params: CommitParams): Record<string, any> {
    return {
      message: params.message,
      all: params.all,
      amend: params.amend,
      noStage: params.noStage,
    };
  }
}

/**
 * Factory functions for creating basic operations
 */
export const createCloneOperation = (deps?: GitOperationDependencies) =>
  new CloneOperation(deps);

export const createBranchOperation = (deps?: GitOperationDependencies) =>
  new BranchOperation(deps);

export const createPushOperation = (deps?: GitOperationDependencies) =>
  new PushOperation(deps);

export const createCommitOperation = (deps?: GitOperationDependencies) =>
  new CommitOperation(deps);