import { join } from "node:path";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { PushOptions, PushResult } from "../types";
import type { PushChangesParams } from "./types";

/**
 * Push changes with dependencies (for testing)
 */
export async function pushChanges(
  params: PushChangesParams,
  deps?: { gitService?: any }
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
    result 
  });
  
  return result;
}

/**
 * Push changes from parameters
 */
export async function pushFromParams(params: {
  session?: string;
  repo?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
}): Promise<PushResult> {
  const gitService = createGitService();
  
  const options: PushOptions = {
    session: params.session,
    repoPath: params.repo,
    remote: params.remote,
    force: params.force,
    debug: params.debug,
  };
  
  const result = await gitService.push(options);
  
  if (params.debug) {
    log.debug("Changes pushed successfully", { 
      session: params.session,
      repo: params.repo,
      remote: params.remote,
      force: params.force,
      result 
    });
  }
  
  return result;
} 
