/**
 * Session Repair Command
 * 
 * Provides repair functionality for various session state issues:
 * - PR state cleanup and correction
 * - Backend type synchronization  
 * - Branch format corrections
 * - Workspace validation
 */
import { log } from "../../../utils/log";
import { SessionProviderInterface } from "../session-db";
import { createSessionProvider } from "../session-db-adapter";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { createGitService } from "../../git/git-service";
import { createRepositoryBackendFromSession } from "../repository-backend-detection";
import { GitServiceInterface } from "../../git/git-service-interface";

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
  sessionName: string;
  issuesFound: RepairIssue[];
  repairsApplied: RepairAction[];
  repairsSkipped: RepairAction[];
  success: boolean;
}

export interface RepairIssue {
  type: "pr-state" | "backend-sync" | "branch-format" | "workspace" | "task-id";
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  details?: any;
  autoFixable: boolean;
}

export interface RepairAction {
  type: string;
  description: string;
  applied: boolean;
  error?: string;
}

export interface SessionRepairDependencies {
  sessionDB?: SessionProviderInterface;
  gitService?: GitServiceInterface;
}

/**
 * Main session repair function
 */
export async function sessionRepair(
  params: SessionRepairParameters,
  deps?: SessionRepairDependencies
): Promise<SessionRepairResult> {
  const sessionDB = deps?.sessionDB || createSessionProvider();
  const gitService = deps?.gitService || createGitService();

  log.debug("Starting session repair", { params });

  // Resolve session context
  const resolvedContext = await resolveSessionContextWithFeedback({
    session: params.name,
    task: params.task,
    repo: params.repo,
    sessionProvider: sessionDB,
    allowAutoDetection: true,
  });

  const sessionName = resolvedContext.sessionName;
  log.debug("Resolved session for repair", { sessionName });

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionName);
  if (!sessionRecord) {
    throw new Error(`Session '${sessionName}' not found`);
  }

  // Analyze session for issues
  const issuesFound = await analyzeSessionIssues(sessionRecord, sessionDB, gitService, params);
  
  log.cli(`🔍 Found ${issuesFound.length} potential issues in session '${sessionName}'`);
  
  if (params.debug) {
    issuesFound.forEach(issue => {
      log.cli(`  ${issue.severity.toUpperCase()}: ${issue.description}`);
    });
  }

  // If dry run, just report issues
  if (params.dryRun) {
    return {
      sessionName,
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
  
  log.cli(`🔧 Repair complete: ${repairsApplied.length} repairs applied, ${repairsSkipped.length} skipped`);

  return {
    sessionName,
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
  sessionRecord: any,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface,
  params: SessionRepairParameters
): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  // Check PR state issues
  if (!params.backendSync || params.prState) {
    const prIssues = await analyzePRStateIssues(sessionRecord, sessionDB, gitService);
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
 * Check for PR state related issues
 */
async function analyzePRStateIssues(
  sessionRecord: any,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface
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
        expectedBranch: sessionRecord.session 
      },
      autoFixable: true,
    });
  }

  // Check for stale PR state with non-existent branches
  if (sessionRecord.prState?.branchName) {
    try {
      const workdir = await sessionDB.getSessionWorkdir(sessionRecord.session);
      const branchExists = await gitService.execInRepository(
        workdir,
        `git rev-parse --verify ${sessionRecord.prState.branchName}`
      ).then(() => true).catch(() => false);

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

  return issues;
}

/**
 * Check for backend synchronization issues
 */
async function analyzeBackendSyncIssues(
  sessionRecord: any,
  sessionDB: SessionProviderInterface,
  gitService: GitServiceInterface
): Promise<RepairIssue[]> {
  const issues: RepairIssue[] = [];

  // Check if backend type matches actual repository
  try {
    const repositoryBackend = await createRepositoryBackendFromSession(sessionRecord);
    const actualBackendType = repositoryBackend.constructor.name.toLowerCase().replace("backend", "");
    
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
  sessionRecord: any,
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
    
    default:
      throw new Error(`Unknown repair type: ${issue.type}`);
  }
}

/**
 * Repair incorrect branch format for GitHub backend
 */
async function repairBranchFormat(
  issue: RepairIssue,
  sessionRecord: any,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  const correctBranch = issue.details.expectedBranch;
  
  await sessionDB.updateSession(sessionRecord.session, {
    ...sessionRecord,
    prBranch: correctBranch,
    prState: {
      ...sessionRecord.prState,
      branchName: correctBranch,
    },
  });

  return {
    type: "branch-format",
    description: `Fixed branch format: '${issue.details.currentBranch}' → '${correctBranch}'`,
    applied: true,
  };
}

/**
 * Clear stale PR state
 */
async function repairPRState(
  issue: RepairIssue,
  sessionRecord: any,
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
    description: `Cleared stale PR state (branch: ${issue.details.branchName})`,
    applied: true,
  };
}

/**
 * Sync backend type with actual repository
 */
async function repairBackendSync(
  issue: RepairIssue,
  sessionRecord: any,
  sessionDB: SessionProviderInterface
): Promise<RepairAction> {
  const correctBackendType = issue.details.actualType;
  
  await sessionDB.updateSession(sessionRecord.session, {
    ...sessionRecord,
    backendType: correctBackendType,
  });

  return {
    type: "backend-sync",
    description: `Updated backend type: '${issue.details.recordedType}' → '${correctBackendType}'`,
    applied: true,
  };
}
