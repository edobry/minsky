import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { PrOptions, PrResult, MergePrOptions, MergePrResult } from "../types";

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
}): Promise<PrResult> {
  const gitService = createGitService();
  const options: PrOptions = {
    session: params.session,
    repoPath: params.repo,
    taskId: params.taskId,
    branch: params.branch,
    debug: params.debug,
    noStatusUpdate: params.noStatusUpdate,
  };

  if (!gitService.pr) {
    throw new Error("Git service does not support creating pull requests.");
  }

  const result = await gitService.pr(options);

  if (params.debug) {
    log.debug("Pull request created successfully", { result });
  }

  return {
    markdown: result.markdown,
    statusUpdateResult: result.statusUpdateResult,
  };
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

  if (!gitService.mergePr) {
    throw new Error("Git service does not support merging pull requests.");
  }

  const result = await gitService.mergePr(options);
  log.debug("Pull request merged successfully", { result });

  return result;
}
