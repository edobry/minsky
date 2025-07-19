import { join } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { createSessionProvider } from "../../session";
import { TaskService, TASK_STATUS } from "../tasks";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import {
  PrOptions,
  PrResult,
  PreparePrOptions,
  PreparePrResult,
  MergePrOptions,
  MergePrResult,
} from "../types";

/**
 * Creates a pull request from parameters
 */
export async function createPullRequestFromParams(params: {
  session?: string;
  repo?: string;
  branch?: string;
  taskId?: string;
  debug?: boolean;
  noStatusUpdate?: boolean;
}): Promise<{ markdown: string; statusUpdateResult?: any }> {
  const gitService = createGitService();
  const options: PrOptions = {
    session: params.session,
    repoPath: params.repo,
    taskId: params.taskId,
    branch: params.branch,
    debug: params.debug,
    noStatusUpdate: params.noStatusUpdate,
  };

  const result = await gitService.pr(options);
  
  if (params.debug) {
    log("Pull request created successfully", { result });
  }
  
  return {
    markdown: result.markdown,
    statusUpdateResult: result.statusUpdateResult,
  };
}

/**
 * Prepare a pull request with enhanced options
 */
export async function preparePrFromParams(params: {
  session?: string;
  repo?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  branchName?: string;
  debug?: boolean;
}): Promise<PreparePrResult> {
  const gitService = createGitService();
  const options: PreparePrOptions = {
    session: params.session,
    repoPath: params.repo,
    baseBranch: params.baseBranch,
    title: params.title,
    body: params.body,
    branchName: params.branchName,
    debug: params.debug,
  };

  const result = await gitService.preparePr(options);
  
  if (params.debug) {
    log("Pull request prepared successfully", { result });
  }
  
  return result;
}

/**
 * Merge a pull request
 */
export async function mergePrFromParams(params: {
  prBranch: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
}): Promise<MergePrResult> {
  const gitService = createGitService();
  const options: MergePrOptions = {
    prBranch: params.prBranch,
    repoPath: params.repo,
    baseBranch: params.baseBranch,
    session: params.session,
  };

  const result = await gitService.mergePr(options);
  log("Pull request merged successfully", { result });
  
  return result;
} 
