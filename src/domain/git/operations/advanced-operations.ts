/**
 * Git Advanced Operations
 * 
 * Operations for advanced git functionality (merge, checkout, rebase).
 * Extracted from git.ts as part of modularization effort.
 */
import { BaseGitOperation, type GitOperationDependencies, type BaseGitOperationParams } from "./base-git-operation";
import { type GitServiceInterface } from "../types";
import { getErrorMessage } from "../../../errors/index";

/**
 * Parameters for merge operation
 */
interface MergeParams extends BaseGitOperationParams {
  sourceBranch: string;
  targetBranch?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}

/**
 * Parameters for checkout operation
 */
interface CheckoutParams extends BaseGitOperationParams {
  branch: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}

/**
 * Parameters for rebase operation
 */
interface RebaseParams extends BaseGitOperationParams {
  baseBranch: string;
  featureBranch?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}

/**
 * Merge branches operation with conflict detection
 */
export class MergeOperation extends BaseGitOperation<MergeParams, any> {
  getOperationName(): string {
    return "merge branches";
  }

  async executeOperation(
    params: MergeParams,
    gitService: GitServiceInterface
  ): Promise<any> {
    const repoPath = params.repo || gitService.getSessionWorkdir(params.session || "");
    const targetBranch = params.targetBranch || "HEAD";

    const result = await gitService.mergeWithConflictPrevention(
      repoPath,
      params.sourceBranch,
      targetBranch,
      {
        dryRun: params.preview,
        autoResolveDeleteConflicts: params.autoResolve,
        skipConflictCheck: false,
      }
    );

    return result;
  }

  protected getAdditionalLogContext(params: MergeParams): Record<string, any> {
    return {
      sourceBranch: params.sourceBranch,
      targetBranch: params.targetBranch,
      preview: params.preview,
      autoResolve: params.autoResolve,
      conflictStrategy: params.conflictStrategy,
    };
  }
}

/**
 * Checkout/switch branches operation with conflict detection
 */
export class CheckoutOperation extends BaseGitOperation<CheckoutParams, any> {
  getOperationName(): string {
    return "checkout branch";
  }

  async executeOperation(
    params: CheckoutParams,
    gitService: GitServiceInterface
  ): Promise<any> {
    const repoPath = params.repo || gitService.getSessionWorkdir(params.session || "");

    // Use ConflictDetectionService to check for branch switch conflicts
    const { ConflictDetectionService } = await import("../conflict-detection");

    if (params.preview) {
      // Just preview the operation
      const warning = await ConflictDetectionService.checkBranchSwitchConflicts(
        repoPath,
        params.branch
      );
      return {
        workdir: repoPath,
        switched: false,
        conflicts: warning.wouldLoseChanges,
        conflictDetails: warning.wouldLoseChanges
          ? `Switching to ${params.branch} would lose uncommitted changes. ${warning.recommendedAction}`
          : undefined,
        warning: {
          wouldLoseChanges: warning.wouldLoseChanges,
          recommendedAction: warning.recommendedAction,
        },
      };
    }

    // Perform actual checkout
    await gitService.execInRepository(repoPath, `checkout ${params.branch}`);

    return {
      workdir: repoPath,
      switched: true,
      conflicts: false,
    };
  }

  protected getAdditionalLogContext(params: CheckoutParams): Record<string, any> {
    return {
      branch: params.branch,
      preview: params.preview,
      autoResolve: params.autoResolve,
      conflictStrategy: params.conflictStrategy,
    };
  }
}

/**
 * Rebase branches operation with conflict detection
 */
export class RebaseOperation extends BaseGitOperation<RebaseParams, any> {
  getOperationName(): string {
    return "rebase branch";
  }

  async executeOperation(
    params: RebaseParams,
    gitService: GitServiceInterface
  ): Promise<any> {
    const repoPath = params.repo || gitService.getSessionWorkdir(params.session || "");
    const featureBranch = params.featureBranch || "HEAD";

    // Use ConflictDetectionService to predict rebase conflicts
    const { ConflictDetectionService } = await import("../conflict-detection");

    const prediction = await ConflictDetectionService.predictRebaseConflicts(
      repoPath,
      params.baseBranch,
      featureBranch
    );

    if (params.preview) {
      // Just preview the operation
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: !prediction.canAutoResolve,
        conflictDetails: prediction.recommendations.join("\n"),
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity,
        },
      };
    }

    // Perform actual rebase if no conflicts or auto-resolve enabled
    if (prediction.canAutoResolve || params.autoResolve) {
      await gitService.execInRepository(repoPath, `rebase ${params.baseBranch}`);
      return {
        workdir: repoPath,
        rebased: true,
        conflicts: false,
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity,
        },
      };
    } else {
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: true,
        conflictDetails:
          "Rebase would create conflicts. Use --preview to see details or --auto-resolve to attempt automatic resolution.",
        prediction: {
          canAutoResolve: prediction.canAutoResolve,
          recommendations: prediction.recommendations,
          overallComplexity: prediction.overallComplexity,
        },
      };
    }
  }

  protected getAdditionalLogContext(params: RebaseParams): Record<string, any> {
    return {
      baseBranch: params.baseBranch,
      featureBranch: params.featureBranch,
      preview: params.preview,
      autoResolve: params.autoResolve,
      conflictStrategy: params.conflictStrategy,
    };
  }
}

/**
 * Factory functions for creating advanced operations
 */
export const createMergeOperation = (deps?: GitOperationDependencies) =>
  new MergeOperation(deps);

export const createCheckoutOperation = (deps?: GitOperationDependencies) =>
  new CheckoutOperation(deps);

export const createRebaseOperation = (deps?: GitOperationDependencies) =>
  new RebaseOperation(deps);