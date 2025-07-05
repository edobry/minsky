import { join } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { createSessionProvider } from "../session";
import { log } from "../../utils/logger";
import { createGitService } from "../git";
import { PushOptions, PushResult } from "../types";

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
    log("Changes pushed successfully", { 
      session: params.session,
      repo: params.repo,
      remote: params.remote,
      force: params.force,
      result 
    });
  }
  
  return result;
} 
