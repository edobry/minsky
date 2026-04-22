/**
 * Session Repair Command
 *
 * Provides repair functionality for various session state issues:
 * - PR state cleanup and correction
 * - Backend type synchronization
 * - Branch format corrections
 * - Workspace validation
 */
import { log } from "../../../utils/logger";
import type { SessionProviderInterface, SessionRecord } from "../types";
import type { PullRequestInfo } from "../session-db";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { createRepositoryBackendFromSession } from "../session-pr-operations";
import { getRepositoryBackendFromConfig } from "../repository-backend-detection";
import { type GitServiceInterface } from "../../git";
import { taskIdToBranchName } from "../../tasks/task-id";
import { findPRNumberForBranch, createOctokit } from "../../repository/github-pr-operations";
import { FallbackTokenProvider, type TokenProvider } from "../../auth";
import { projectPrState } from "../session-update-operations";

export interface SessionRepairParameters {
  name?: string;
  task?: string;
  repo?: string;
  dryRun?: boolean;
  auto?: boolean;
  interactive?: boolean;
  prState?: boolean;
  backendSync?: boolean;
  force?: boolean;
  debug?: boolean;
}

export interface SessionRepairResult {
  sessionId: string;
  issuesFound: RepairIssue[];
  repairsApplied: RepairAction[];
  repairsSkipped: RepairAction[];
  success: boolean;
}

export interface RepairIssue {
  type: "pr-state" | "backend-sync" | "branch-format" | "workspace" | "task-id" | "missing-pr";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  details?: Record<string, unknown>;
  autoFixable: boolean;
}

export interface RepairAction {
  type: string;
  description: string;
  applied: boolean;
  error?: string;
}

export interface SessionRepairDependencies {
  sessionDB: SessionProviderInterface;
  gitService: GitServiceInterface;
  /** Optional token provider for GitHub API authentication. Falls back to config when omitted. */
  tokenProvider?: TokenProvider;
}

/**
 * Main session repair function
 */
export async function sessionRepair(
  params: SessionRepairParameters,
  deps: SessionRepairDependencies
): Promise<SessionRepairResult> {
  const { sessionDB, gitService } = deps;

  log.debug("Starting session repair", { params });

  // Resolve session context
  const resolvedContext = await resolveSessionContextWithFeedback({
    session: params.name,
    task: params.task,
    repo: params.repo,
    sessionProvider: sessionDB,
    allowAutoDetection: true,
  });

  const sessionId = resolvedContext.sessionId;
  log.debug("Resolved session for repair", { sessionId });

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord) {
    throw new Error(`Session '${sessionId}' not found`);
  }

  // Analyze session for issues
  const issuesFound = await analyzeSessionIssues(
    sessionRecord,
    sessionDB,
    gitService,
    params,
    deps.tokenProvider
  );

  log.cli(`🔍 Found ${issuesFound.length} potential issues in session '${sessionId}'`);

  if (params.debug) {
    issuesFound.forEach((issue) => {
      log.cli(`  ${issue.severity.toUpperCase()}: ${issue.description}`);
    });
  }

  // If dry run, just report issues
  if (params.dryRun) {
    return {
      sessionId,
      issuesFound,
      repairsApplied: [],
      repairsSkipped: [],
      success: true,
    };
  }

  // Apply repairs
  const repairsApplied: RepairAction[] = [];
  const repairsSkipped: RepairAction[] = [];

  for (const issue of issuesFound) {
    if (!issue.autoFixable && !params.force) {
      repairsSkipped.push({
        type: issue.type,
        description: `Skipped ${issue.type}: ${issue.description} (requires --force)`,
        applied: false,
      });
      continue;
    }

    if (params.interactive && !params.auto) {
      // In interactive mode, we would prompt user
      // For now, skip non-auto repairs in interactive mode
      repairsSkipped.push({
        type: issue.type,
        description: `Skipped ${issue.type}: Interactive mode not fully implemented`,
        applied: false,
      });
      continue;
    }

    try {
      const repairAction = await applyRepair(issue, sessionRecord, sessionDB, gitService);
      repairsApplied.push(repairAction);
      log.cli(`✅ ${repairAction.description}`);
    } catch (error) {
      const failedAction: RepairAction = {
        type: issue.type,
        description: `Failed to repair ${issue.type}: ${issue.description}`,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      };
      repairsSkipped.push(failedAction);
      log.warn(`❌ ${failedAction.description}`, { error: failedAction.error });
    }
  }

  const success = repairsApplied.length > 0 || issuesFound.length === 0;

  log.cli(
    `🔧 Repair complete: ${repairsApplied.length} repairs applied, ${repairsSkipped.length} skipped`
  );

  return {
    sessionId,
    issuesFound,
    repairsApplied,
    repairsSkipped,
    success,
  };
}

/**
 * Analyze session for various types of issues
 */
async function analyzeSessionIssues(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface,
  params: SessionRepairParameters,
  tokenProvider?: TokenProvider
): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  // Check PR state issues
  if (!params.backendSync || params.prState) {
    const prIssues = await analyzePRStateIssues(
      sessionRecord,
      sessionDB,
      gitService,
      tokenProvider
    );
    issues.push(...prIssues);
  }

  // Check backend synchronization
  if (!params.prState || params.backendSync) {
    const backendIssues = await analyzeBackendSyncIssues(sessionRecord, sessionDB, gitService);
    issues.push(...backendIssues);
  }

  return issues;
}

/**
 * Parse a GitHub URL into owner and repo components.
 * Supports both HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 */
function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  if (!repoUrl) return null;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = repoUrl.match(/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?$/);
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = repoUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch && httpsMatch[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  return null;
}

/**
 * Check for PR state related issues
 */
export async function analyzePRStateIssues(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface,
  tokenProvider?: TokenProvider
): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  // Check for incorrect pr/ branch format with GitHub backend
  if (sessionRecord.backendType === "github" && sessionRecord.prBranch?.startsWith("pr/")) {
    issues.push({
      type: "branch-format",
      severity: "medium",
      description: "GitHub backend using incorrect 'pr/' branch format",
      details: {
        currentBranch: sessionRecord.prBranch,
        expectedBranch: sessionRecord.session,
      },
      autoFixable: true,
    });
  }

  // Check for stale PR state with non-existent branches
  if (sessionRecord.prState?.branchName) {
    try {
      const workdir = await sessionDB.getSessionWorkdir(sessionRecord.session);
      const branchExists = await gitService
        .execInRepository(workdir, `git rev-parse --verify ${sessionRecord.prState.branchName}`)
        .then(() => true)
        .catch(() => false);

      if (!branchExists) {
        issues.push({
          type: "pr-state",
          severity: "medium",
          description: "PR state references non-existent branch",
          details: { branchName: sessionRecord.prState.branchName },
          autoFixable: true,
        });
      }
    } catch (error) {
      log.debug("Could not check branch existence", { error });
    }
  }

  // Check for missing PR metadata when GitHub has a PR for this session's branch
  if (
    !sessionRecord.pullRequest &&
    sessionRecord.taskId &&
    sessionRecord.backendType === "github"
  ) {
    try {
      const gh = parseGitHubRepoUrl(sessionRecord.repoUrl);
      if (gh) {
        // Use injected provider or fall back to config-based token
        const resolvedTokenProvider =
          tokenProvider ??
          (() => {
            const { getConfiguration } = require("../../configuration/index");
            const config = getConfiguration();
            const token = config.github?.token || "";
            return new FallbackTokenProvider(token);
          })();
        const token = await resolvedTokenProvider.getServiceToken();
        const octokit = createOctokit(token);
        const branchName = taskIdToBranchName(sessionRecord.taskId);

        try {
          const ghContext = { ...gh, getToken: () => resolvedTokenProvider.getServiceToken() };
          const prNumber = await findPRNumberForBranch(branchName, ghContext, octokit);
          const prResponse = await octokit.rest.pulls.get({
            owner: gh.owner,
            repo: gh.repo,
            pull_number: prNumber,
          });
          const pr = prResponse.data;

          const prState = pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed";

          issues.push({
            type: "missing-pr",
            severity: "high",
            description: `Session has no PR metadata but PR #${prNumber} exists on GitHub for branch ${branchName}`,
            details: {
              prNumber,
              prUrl: pr.html_url,
              prState,
              headBranch: pr.head.ref,
              baseBranch: pr.base.ref,
              createdAt: pr.created_at,
              mergedAt: pr.merged_at || undefined,
              author: pr.user?.login || "unknown",
              nodeId: pr.node_id,
              id: pr.id,
            },
            autoFixable: true,
          });
        } catch (lookupError) {
          // No PR found or lookup failed — skip silently
          log.debug("Could not find PR for session branch", {
            session: sessionRecord.session,
            branch: branchName,
            error: lookupError,
          });
        }
      }
    } catch (error) {
      // Token provider failed or URL parsing failed — skip silently
      log.debug("Could not check GitHub for missing PR", {
        session: sessionRecord.session,
        error,
      });
    }
  }

  return issues;
}

/**
 * Check for backend synchronization issues
 */
async function analyzeBackendSyncIssues(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface,
  _gitService: GitServiceInterface
): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  // Check for missing backendType on session record
  if (!sessionRecord.backendType) {
    try {
      const { backendType: configBackendType } = await getRepositoryBackendFromConfig();
      issues.push({
        type: "backend-sync",
        severity: "medium",
        description: "Session record is missing backendType",
        details: {
          recordedType: undefined,
          suggestedType: configBackendType,
          fromConfig: true,
        },
        autoFixable: true,
      });
    } catch (error) {
      log.debug("Could not read project config for backendType suggestion", { error });
      issues.push({
        type: "backend-sync",
        severity: "medium",
        description: "Session record is missing backendType and project config is unavailable",
        details: { recordedType: undefined },
        autoFixable: false,
      });
    }
    // Skip the mismatch check below when backendType is absent
    return issues;
  }

  // Check if backend type matches actual repository
  try {
    const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord, sessionDB);
    const actualBackendType = repositoryBackend.constructor.name
      .toLowerCase()
      .replace("backend", "");

    if (sessionRecord.backendType !== actualBackendType) {
      issues.push({
        type: "backend-sync",
        severity: "high",
        description: `Backend type mismatch: record shows '${sessionRecord.backendType}' but actual is '${actualBackendType}'`,
        details: {
          recordedType: sessionRecord.backendType,
          actualType: actualBackendType,
        },
        autoFixable: true,
      });
    }
  } catch (error) {
    issues.push({
      type: "backend-sync",
      severity: "critical",
      description: "Cannot determine repository backend type",
      details: { error: error instanceof Error ? error.message : String(error) },
      autoFixable: false,
    });
  }

  return issues;
}

/**
 * Apply a specific repair action
 */
async function applyRepair(
  issue: RepairIssue,
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface
): Promise<RepairAction> {
  switch (issue.type) {
    case "branch-format":
      return await repairBranchFormat(issue, sessionRecord, sessionDB);

    case "pr-state":
      return await repairPRState(issue, sessionRecord, sessionDB);

    case "backend-sync":
      return await repairBackendSync(issue, sessionRecord, sessionDB);

    case "missing-pr":
      return await repairMissingPR(issue, sessionRecord, sessionDB);

    default:
      throw new Error(`Unknown repair type: ${issue.type}`);
  }
}

/**
 * Repair incorrect branch format for GitHub backend
 */
export async function repairBranchFormat(
  issue: RepairIssue,
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  const correctBranch = issue.details?.expectedBranch as string;

  await sessionDB.updateSession(sessionRecord.session, {
    ...sessionRecord,
    prBranch: correctBranch,
    prState: {
      ...(sessionRecord.prState ? projectPrState(sessionRecord.prState) : {}),
      branchName: correctBranch,
      lastChecked: new Date().toISOString(),
    },
  });

  return {
    type: "branch-format",
    description: `Fixed branch format: '${issue.details?.currentBranch}' → '${correctBranch}'`,
    applied: true,
  };
}

/**
 * Clear stale PR state
 */
async function repairPRState(
  issue: RepairIssue,
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  await sessionDB.updateSession(sessionRecord.session, {
    ...sessionRecord,
    prBranch: undefined,
    prState: undefined,
    pullRequest: undefined,
  });

  return {
    type: "pr-state",
    description: `Cleared stale PR state (branch: ${issue.details?.branchName})`,
    applied: true,
  };
}

/**
 * Sync backend type with actual repository
 */
async function repairBackendSync(
  issue: RepairIssue,
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  const recordedType = issue.details?.recordedType as string | undefined;
  const actualType = issue.details?.actualType as string | undefined;
  const suggestedType = issue.details?.suggestedType as string | undefined;

  let newBackendType: string;

  if (suggestedType) {
    // Missing backendType: use value from project config
    newBackendType = suggestedType;
  } else if (recordedType) {
    // Mismatch: prefer the actually-detected type
    newBackendType = actualType || recordedType;
  } else {
    // Final fallback: read project config
    try {
      const { backendType: configBackendType } = await getRepositoryBackendFromConfig();
      newBackendType = configBackendType;
    } catch {
      newBackendType = "github";
    }
  }

  await sessionDB.updateSession(sessionRecord.session, {
    ...sessionRecord,
    backendType: newBackendType as "github",
  });

  return {
    type: "backend-sync",
    description: `Updated backend type: '${recordedType ?? "undefined"}' → '${newBackendType}'`,
    applied: true,
  };
}

/**
 * Backfill missing PR metadata from GitHub
 */
async function repairMissingPR(
  issue: RepairIssue,
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  const {
    prNumber,
    prUrl,
    prState,
    headBranch,
    baseBranch,
    createdAt,
    mergedAt,
    author,
    nodeId,
    id,
  } = issue.details as {
    prNumber: number;
    prUrl: string;
    prState: "open" | "closed" | "merged";
    headBranch: string;
    baseBranch: string;
    createdAt: string;
    mergedAt?: string;
    author: string;
    nodeId: string;
    id: number;
  };

  const pullRequest: PullRequestInfo = {
    number: prNumber,
    url: prUrl,
    state: prState,
    createdAt,
    mergedAt,
    headBranch,
    baseBranch,
    github: {
      id,
      nodeId,
      htmlUrl: prUrl,
      author,
    },
    lastSynced: new Date().toISOString(),
  };

  await sessionDB.updateSession(sessionRecord.session, {
    pullRequest,
    prBranch: headBranch,
    prState: {
      branchName: headBranch,
      lastChecked: new Date().toISOString(),
      ...(mergedAt ? { mergedAt } : {}),
    },
  });

  return {
    type: "missing-pr",
    description: `Backfilled PR #${prNumber} metadata from GitHub`,
    applied: true,
  };
}
