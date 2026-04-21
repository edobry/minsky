import { injectable } from "tsyringe";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { normalizeRepoName } from "./repo-utils";
import { execAsync } from "../utils/exec";
import { type SessionProviderInterface, type SessionRecord } from "./session";

import { log } from "../utils/logger";
import { getMinskyStateDir } from "../utils/paths";
import {
  ConflictDetectionService,
  ConflictPrediction,
  BranchDivergenceAnalysis,
  EnhancedMergeResult,
  SmartUpdateResult,
} from "./git/conflict-detection";
import { mergePrImpl } from "./git/merge-pr-operations";
import { mergeBranchImpl } from "./git/merge-branch-operations";
import { prWithDependenciesImpl } from "./git/pr-generation-operations";
import { pushImpl } from "./git/push-operations";
import { cloneImpl, type CloneDependencies } from "./git/clone-operations";

// Import extracted operation modules
import {
  getStatusImpl,
  stageAllImpl,
  stageModifiedImpl,
  commitImpl,
  stashChangesImpl,
  popStashImpl,
  fetchLatestImpl,
  getCurrentBranchImpl,
  hasUncommittedChangesImpl,
  fetchDefaultBranchImpl,
  execInRepositoryImpl,
} from "./git/git-core-operations";
import {
  commitWithDepsImpl,
  stashChangesWithDepsImpl,
  popStashWithDepsImpl,
  mergeBranchWithDepsImpl,
  stageAllWithDepsImpl,
  stageModifiedWithDepsImpl,
  pullLatestWithDepsImpl,
  branchWithDepsImpl,
  fetchDefaultBranchWithDepsImpl,
} from "./git/git-with-deps";

// Import types used by GitService; re-export all public types
import type {
  GitServiceInterface,
  PrDependencies,
  BasicGitDependencies,
  BranchOptions,
  BranchResult,
  GitStatus,
  StashResult,
  PullResult,
  MergeResult,
  CloneOptions,
  CloneResult,
  PrOptions,
  PrResult,
  PushOptions,
  PushResult,
  MergePrOptions,
  MergePrResult,
} from "./git/types";

export type * from "./git/types";

// Re-export *FromParams facade functions
export {
  createPullRequestFromParams,
  commitChangesFromParams,
  mergePrFromParams,
  cloneFromParams,
  branchFromParams,
  pushFromParams,
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
} from "./git/git-params-facade";

/**
 * Dependencies that can be injected into GitService at construction time.
 */
export interface GitServiceDeps {
  baseDir?: string;
  sessionProvider?: SessionProviderInterface;
}

@injectable()
export class GitService implements GitServiceInterface {
  private readonly baseDir: string;
  private sessionDb: SessionProviderInterface | null = null;

  constructor(baseDirOrDeps?: string | GitServiceDeps | null) {
    if (typeof baseDirOrDeps === "string") {
      this.baseDir = baseDirOrDeps || getMinskyStateDir();
    } else if (baseDirOrDeps != null) {
      this.baseDir = baseDirOrDeps.baseDir || getMinskyStateDir();
      if (baseDirOrDeps.sessionProvider) {
        this.sessionDb = baseDirOrDeps.sessionProvider;
      }
    } else {
      this.baseDir = getMinskyStateDir();
    }
  }

  private async getSessionDb(): Promise<SessionProviderInterface> {
    if (!this.sessionDb) {
      throw new Error(
        "GitService has no sessionProvider. " +
          "Pass sessionProvider via constructor deps or use the DI container."
      );
    }
    return this.sessionDb;
  }

  public async getSessionRecord(sessionId: string): Promise<SessionRecord | null | undefined> {
    const db = await this.getSessionDb();
    return db.getSession(sessionId);
  }

  private async ensureBaseDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 8);
  }

  getSessionWorkdir(session: string): string {
    return join(this.baseDir, "sessions", session);
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    await this.ensureBaseDir();
    const fs = await import("fs/promises");
    return cloneImpl(options, {
      execAsync,
      mkdir: fs.mkdir,
      readdir: fs.readdir,
      access: fs.access,
      rm: fs.rm,
      generateSessionId: this.generateSessionId.bind(this),
    });
  }

  async cloneWithDependencies(
    options: CloneOptions,
    deps: CloneDependencies
  ): Promise<CloneResult> {
    await (deps.ensureBaseDir ?? (() => this.ensureBaseDir()))();
    return cloneImpl(options, deps);
  }

  async branch(options: BranchOptions): Promise<BranchResult> {
    await this.ensureBaseDir();
    log.debug("Getting session for branch", { session: options.session });

    const record = await (await this.getSessionDb()).getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }

    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    log.debug("Branch: got repoName", { repoName });

    const workdir = this.getSessionWorkdir(options.session);
    log.debug("Branch: calculated workdir", { workdir });

    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return { workdir, branch: options.branch };
  }

  async branchWithoutSession(options: {
    repoName: string;
    session: string;
    branch: string;
  }): Promise<BranchResult> {
    await this.ensureBaseDir();
    const workdir = this.getSessionWorkdir(options.session);
    await execAsync(`git -C ${workdir} checkout -b ${options.branch}`);
    return { workdir, branch: options.branch };
  }

  async pr(options: PrOptions): Promise<PrResult> {
    await this.ensureBaseDir();
    const deps: PrDependencies = {
      execAsync,
      getSession: async (name: string) => (await this.getSessionDb()).getSession(name),
      getSessionWorkdir: (session: string) => this.getSessionWorkdir(session),
      getSessionByTaskId: async (taskId: string) =>
        (await this.getSessionDb()).getSessionByTaskId?.(taskId),
    };
    return await this.prWithDependencies(options, deps);
  }

  async prWithDependencies(options: PrOptions, deps: PrDependencies): Promise<PrResult> {
    const extendedDeps = {
      ...deps,
      ensureBaseDir: () => this.ensureBaseDir(),
    };
    return await prWithDependenciesImpl(options, extendedDeps);
  }

  async getStatus(repoPath?: string): Promise<GitStatus> {
    return getStatusImpl(execAsync, repoPath);
  }

  async stageAll(repoPath?: string): Promise<void> {
    return stageAllImpl(execAsync, repoPath);
  }

  async stageModified(repoPath?: string): Promise<void> {
    return stageModifiedImpl(execAsync, repoPath);
  }

  async commit(message: string, repoPath?: string, amend: boolean = false): Promise<string> {
    return commitImpl(execAsync, message, repoPath, amend);
  }

  async stashChanges(workdir: string): Promise<StashResult> {
    return stashChangesImpl(execAsync, workdir);
  }

  async popStash(workdir: string): Promise<StashResult> {
    return popStashImpl(execAsync, workdir);
  }

  async fetchLatest(workdir: string, remote: string = "origin"): Promise<PullResult> {
    return fetchLatestImpl(execAsync, workdir, remote);
  }

  async mergeBranch(workdir: string, branch: string): Promise<MergeResult> {
    return mergeBranchImpl(workdir, branch, { execAsync });
  }

  async push(options: PushOptions): Promise<PushResult> {
    await this.ensureBaseDir();
    return pushImpl(options, {
      execAsync,
    });
  }

  public async execInRepository(workdir: string, command: string): Promise<string> {
    return execInRepositoryImpl(execAsync, workdir, command);
  }

  async mergePr(options: MergePrOptions): Promise<MergePrResult> {
    return mergePrImpl(options, {
      sessionDb: await this.getSessionDb(),
      getSessionWorkdir: this.getSessionWorkdir.bind(this),
      execInRepository: this.execInRepository.bind(this),
    });
  }

  async fetchDefaultBranch(repoPath: string): Promise<string> {
    return fetchDefaultBranchImpl(this.execInRepository.bind(this), repoPath);
  }

  async fetchDefaultBranchWithDependencies(
    repoPath: string,
    deps: BasicGitDependencies
  ): Promise<string> {
    return fetchDefaultBranchWithDepsImpl(repoPath, deps);
  }

  async commitWithDependencies(
    message: string,
    workdir: string,
    deps: BasicGitDependencies,
    amend: boolean = false
  ): Promise<string> {
    return commitWithDepsImpl(message, workdir, deps, amend);
  }

  async stashChangesWithDependencies(
    workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    return stashChangesWithDepsImpl(workdir, deps);
  }

  async popStashWithDependencies(
    workdir: string,
    deps: BasicGitDependencies
  ): Promise<StashResult> {
    return popStashWithDepsImpl(workdir, deps);
  }

  async mergeBranchWithDependencies(
    workdir: string,
    branch: string,
    deps: BasicGitDependencies
  ): Promise<MergeResult> {
    return mergeBranchWithDepsImpl(workdir, branch, deps);
  }

  async stageAllWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    return stageAllWithDepsImpl(workdir, deps);
  }

  async stageModifiedWithDependencies(workdir: string, deps: BasicGitDependencies): Promise<void> {
    return stageModifiedWithDepsImpl(workdir, deps);
  }

  async pullLatest(repoPath: string, remote: string = "origin"): Promise<PullResult> {
    return pullLatestWithDepsImpl(repoPath, { execAsync }, remote);
  }

  async pullLatestWithDependencies(
    workdir: string,
    deps: BasicGitDependencies,
    remote: string = "origin"
  ): Promise<PullResult> {
    return pullLatestWithDepsImpl(workdir, deps, remote);
  }

  async branchWithDependencies(
    options: BranchOptions,
    deps: PrDependencies
  ): Promise<BranchResult> {
    return branchWithDepsImpl(options, deps);
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    return getCurrentBranchImpl(execAsync, repoPath);
  }

  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    return hasUncommittedChangesImpl(execAsync, repoPath);
  }

  async predictMergeConflicts(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<ConflictPrediction> {
    return ConflictDetectionService.predictConflicts(repoPath, sourceBranch, targetBranch);
  }

  async analyzeBranchDivergence(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string
  ): Promise<BranchDivergenceAnalysis> {
    return ConflictDetectionService.analyzeBranchDivergence(repoPath, sessionBranch, baseBranch);
  }

  async mergeWithConflictPrevention(
    repoPath: string,
    sourceBranch: string,
    targetBranch: string,
    options?: {
      skipConflictCheck?: boolean;
      autoResolveDeleteConflicts?: boolean;
      dryRun?: boolean;
    }
  ): Promise<EnhancedMergeResult> {
    return ConflictDetectionService.mergeWithConflictPrevention(
      repoPath,
      sourceBranch,
      targetBranch,
      options
    );
  }

  async smartSessionUpdate(
    repoPath: string,
    sessionBranch: string,
    baseBranch: string,
    options?: {
      skipIfAlreadyMerged?: boolean;
      autoResolveConflicts?: boolean;
    }
  ): Promise<SmartUpdateResult> {
    return ConflictDetectionService.smartSessionUpdate(
      repoPath,
      sessionBranch,
      baseBranch,
      options
    );
  }
}

/**
 * Creates a default GitService implementation
 */
export function createGitService(options?: GitServiceDeps): GitServiceInterface {
  return new GitService(options);
}
