import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { PushOptions, PushResult } from "../types";
import type { PushChangesParams } from "./types";
import type { GitServiceInterface } from "../types";

/**
 * Push changes with dependencies (for testing)
 */
export async function pushChanges(
  params: PushChangesParams,
  deps?: { gitService?: GitServiceInterface }
): Promise<PushResult> {
  const gitService = deps?.gitService || createGitService();

  const options: PushOptions = {
    repoPath: params.workdir,
    remote: params.remote,
    force: params.force,
  };

  const result = await gitService.push(options);

  log.debug("Changes pushed successfully", {
    workdir: params.workdir,
    branch: params.branch,
    remote: params.remote,
    force: params.force,
    result,
  });

  return result;
}

/**
 * Push changes from parameters.
 * Session must be resolved to a repo path before calling this function.
 */
export async function pushFromParams(params: {
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  const gitService = createGitService();

  const options: PushOptions = {
    repoPath: params.repo,
    remote: params.remote,
    force: params.force,
    debug: params.debug,
  };

  const result = await gitService.push(options);

  if (params.debug) {
    log.debug("Changes pushed successfully", {
      repo: params.repo,
      remote: params.remote,
      force: params.force,
      result,
    });
  }

  return result;
}
