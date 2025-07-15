/**
 * Type definitions for git commands
 */

export interface CloneOptions {
  repoUrl: string;
  workdir: string;
  session?: string;
  branch?: string;
}

export interface CloneResult {
  workdir: string;
  session: string;
}

export interface BranchOptions {
  session: string;
  branch: string;
}

export interface BranchResult {
  workdir: string;
  branch: string;
}

export interface CommitOptions {
  workdir: string;
  message: string;
  files?: string[];
  amend?: boolean;
}

export interface CommitResult {
  workdir: string;
  hash: string;
  message: string;
}

export interface PushOptions {
  session?: string;
  repoPath?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}

export interface PushResult {
  workdir: string;
  pushed: boolean;
}

export interface MergeOptions {
  workdir: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MergeResult {
  workdir: string;
  merged: boolean;
  conflicts: boolean;
}

export interface CheckoutOptions {
  workdir: string;
  branchName: string;
}

export interface CheckoutResult {
  workdir: string;
  branch: string;
}

export interface RebaseOptions {
  workdir: string;
  targetBranch: string;
  sourceBranch: string;
}

export interface RebaseResult {
  workdir: string;
  rebased: boolean;
  conflicts: boolean;
}

export interface PrOptions {
  workdir: string;
  title: string;
  body: string;
  baseBranch: string;
}

export interface PrResult {
  title: string;
  body: string;
  baseBranch: string;
  markdown: string;
}

export interface GitStatus {
  modified: string[];
  untracked: string[];
  deleted: string[];
}

export interface StashResult {
  workdir: string;
  stashed: boolean;
}

export interface PullResult {
  workdir: string;
  updated: boolean;
}

// Parameter types for extracted commands
export interface CloneRepositoryParams {
  repoUrl: string;
  workdir: string;
  session: string;
}

export interface CreateBranchParams {
  workdir: string;
  branchName: string;
  baseBranch?: string;
}

export interface CommitChangesParams {
  workdir: string;
  message: string;
  files?: string[];
  amend?: boolean;
}

export interface PushChangesParams {
  workdir: string;
  branch: string;
  remote?: string;
  force?: boolean;
}

export interface MergeChangesParams {
  workdir: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface CheckoutBranchParams {
  workdir: string;
  branchName: string;
}

export interface RebaseChangesParams {
  workdir: string;
  targetBranch: string;
  sourceBranch: string;
}

export interface GeneratePrParams {
  workdir: string;
  title: string;
  body: string;
  baseBranch: string;
}

// Dependency injection interfaces
export interface GitDependencies {
  execAsync: (command: string, options?: any) => Promise<{ stdout: string; stderr: string }>;
  mkdir?: (path: string, options?: any) => Promise<void>;
  access?: (path: string) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
} 
