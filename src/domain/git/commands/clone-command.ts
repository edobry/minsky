import { join } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../git";
import { CloneOptions, CloneResult } from "../types";

/**
 * Clone a repository from parameters
 */
export async function cloneFromParams(params: {
  url: string;
  workdir: string; // Explicit workdir path
  session?: string;
  branch?: string;
}): Promise<CloneResult> {
  const gitService = createGitService();
  
  const options: CloneOptions = {
    repoUrl: params.url,
    workdir: params.workdir,
    session: params.session,
    branch: params.branch,
  };
  
  const result = await gitService.clone(options);
  
  log("Repository cloned successfully", { 
    url: params.url,
    workdir: result.workdir,
    session: result.session,
    branch: params.branch 
  });
  
  return result;
} 
