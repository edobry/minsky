/**
 * Session record + pull-request types for the sessions domain.
 *
 * (The former `SessionDbState` container and its state-based pure functions
 * were retired with the DatabaseStorage layer in mt#2329; sessions persist via
 * `DrizzleSessionRepository`. `SessionRecord` and the PR types remain here as
 * the canonical domain shapes used across the codebase.)
 */

import type { SessionStatus } from "./types";

/**
 * PR commit information
 */
export interface PullRequestCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * GitHub-specific PR information
 */
export interface PullRequestGitHubInfo {
  id: number; // GitHub PR ID
  nodeId: string; // GitHub GraphQL node ID
  htmlUrl: string; // Web URL
  author: string; // GitHub username
  assignees?: string[]; // GitHub usernames
  reviewers?: string[]; // GitHub usernames
  labels?: string[]; // Label names
  milestone?: string; // Milestone title
  // Persisted by applyPostMergeStateSync (mt#1614) so the merge commit SHA is
  // available on the session record after the at-merge handler fires. Captured
  // from `pull_request.merge_commit_sha` on `pull_request.closed` events.
  mergeCommitSha?: string;
}

/**
 * Pull request information for session records
 * Added to support pr list/get subcommands
 */
export interface PullRequestInfo {
  // Core PR Information (minimal workflow state only)
  number: number;
  url: string;
  state: "open" | "closed" | "merged" | "draft";

  // Timestamps (essential for workflow automation)
  createdAt: string; // ISO timestamp
  mergedAt?: string; // ISO timestamp when merged

  // GitHub-specific information
  github?: PullRequestGitHubInfo;

  // Branch information (essential for git operations)
  headBranch: string; // Source branch (e.g., "pr/task359")
  baseBranch: string; // Target branch (e.g., "main")

  // Metadata
  lastSynced: string; // When this info was last updated from GitHub API

  // Live-fetch fields: not stored persistently but may appear on objects built at runtime
  // (e.g. enrichment pass in pr-get-subcommand.ts)
  updatedAt?: string; // ISO timestamp – populated from live GitHub API response
  title?: string; // PR title – fetched live, not cached
  body?: string; // PR description – fetched live, not cached
  filesChanged?: number; // Count of changed files – fetched live, not cached
  commits?: number; // Count of commits – fetched live, not cached
}

/**
 * Session record structure
 */
export interface SessionRecord {
  sessionId: string;
  repoName: string;
  repoUrl: string;
  repoPath?: string; // Local path to the repository
  createdAt: string;
  taskId?: string;
  backendType?: "github" | "gitlab" | "bitbucket"; // Repository backend type
  lastActivityAt?: string;
  lastCommitHash?: string;
  lastCommitMessage?: string;
  commitCount?: number;
  status?: SessionStatus;
  agentId?: string;
  prState?: {
    branchName: string;
    exists?: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
  pullRequest?: PullRequestInfo;

  // NEW: Simple PR approval tracking (Task #358)
  prBranch?: string; // PR branch if one exists ("pr/session-id")
  prApproved?: boolean; // Whether this session's PR is approved

  // Legacy / compatibility fields
  /** @deprecated Use `sessionId` instead */
  name?: string;
  workspacePath?: string;
  sessionPath?: string;
  /** Branch name - removed from persistent schema but kept for test compatibility */
  branch?: string;
  /** @deprecated Use `createdAt` instead */
  created?: string;
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
}
