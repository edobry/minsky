import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { TaskService } from "../../tasks";
import { getCurrentSession } from "../../workspace";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  SessionReviewParams,
  SessionReviewResult,
  SessionProviderInterface,
  SessionDependencies 
} from "../types";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
import * as WorkspaceUtils from "../../workspace";

/**
 * Reviews a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function sessionReviewFromParams(
  params: SessionReviewParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: any;
    taskService?: any & {
      getTaskSpecData?: (taskId: string) => Promise<string>;
    };
    workspaceUtils?: any;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<SessionReviewResult> {
  const { session, task, repo, output, json, prBranch } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService: depsInput?.taskService || new TaskService(),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session,
      task,
      repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    const sessionRecord = await deps.sessionDB.getSession(resolvedContext.sessionName);
    
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Get session working directory
    const workdir = await deps.sessionDB.getSessionWorkdir(resolvedContext.sessionName);

    // Get task specification if available
    let taskSpec: string | undefined;
    if (sessionRecord.taskId && deps.taskService.getTaskSpecData) {
      try {
        taskSpec = await deps.taskService.getTaskSpecData(sessionRecord.taskId);
      } catch (error) {
        log.debug(`Could not get task spec for task ${sessionRecord.taskId}`, { error });
      }
    }

    // Determine PR branch
    let effectivePrBranch = prBranch;
    if (!effectivePrBranch) {
      try {
        effectivePrBranch = await deps.gitService.getCurrentBranch(workdir);
      } catch (error) {
        effectivePrBranch = sessionRecord.branch || "main";
      }
    }

    // Get base branch
    let baseBranch = "main";
    try {
      baseBranch = await deps.gitService.fetchDefaultBranch(workdir);
    } catch (error) {
      log.debug("Could not fetch default branch, using 'main'", { error });
    }

    // Generate PR description
    let prDescription: string | undefined;
    try {
      const prResult = await deps.gitService.pr({
        repoPath: workdir,
        branch: effectivePrBranch,
        noStatusUpdate: true,
      });
      prDescription = prResult.markdown;
    } catch (error) {
      log.debug("Could not generate PR description", { error });
    }

    // Get diff and stats
    let diff: string | undefined;
    let diffStats: { filesChanged: number; insertions: number; deletions: number } | undefined;
    
    try {
      const diffResult = await deps.gitService.execInRepository(
        workdir,
        `git diff --stat ${baseBranch}...${effectivePrBranch}`
      );
      
      const diffText = await deps.gitService.execInRepository(
        workdir,
        `git diff ${baseBranch}...${effectivePrBranch}`
      );
      
      diff = diffText;
      
      // Parse diff stats
      const statsMatch = diffResult.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      if (statsMatch) {
        diffStats = {
          filesChanged: parseInt(statsMatch[1], 10),
          insertions: parseInt(statsMatch[2] || "0", 10),
          deletions: parseInt(statsMatch[3] || "0", 10),
        };
      }
    } catch (error) {
      log.debug("Could not get diff information", { error });
    }

    const result: SessionReviewResult = {
      session: resolvedContext.sessionName,
      taskId: sessionRecord.taskId,
      taskSpec,
      prDescription,
      prBranch: effectivePrBranch,
      baseBranch,
      diff,
      diffStats,
    };

    // Write output if specified
    if (output) {
      const outputContent = json ? JSON.stringify(result, null, 2) : formatReviewOutput(result);
      await deps.workspaceUtils.writeFile(output, outputContent);
    }

    return result;
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Formats the review output for text display
 */
function formatReviewOutput(result: SessionReviewResult): string {
  const lines = [
    `# Session Review: ${result.session}`,
    "",
  ];

  if (result.taskId) {
    lines.push(`**Task ID:** ${result.taskId}`);
  }

  if (result.taskSpec) {
    lines.push("", "## Task Specification", "", result.taskSpec);
  }

  if (result.prDescription) {
    lines.push("", "## PR Description", "", result.prDescription);
  }

  if (result.diffStats) {
    lines.push("", "## Change Statistics", "");
    lines.push(`- Files changed: ${result.diffStats.filesChanged}`);
    lines.push(`- Insertions: ${result.diffStats.insertions}`);
    lines.push(`- Deletions: ${result.diffStats.deletions}`);
  }

  if (result.diff) {
    lines.push("", "## Diff", "", "```diff", result.diff, "```");
  }

  return lines.join("\n");
} 
