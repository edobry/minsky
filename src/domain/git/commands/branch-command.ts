import { join } from "node:path";
import { normalizeRepoName } from "../../repo-utils";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { BranchOptions, BranchResult } from "../types";

/**
 * Create a branch from parameters
 */
export async function branchFromParams(params: {
  session: string;
  name: string;
}): Promise<BranchResult> {
  const gitService = createGitService();
  
  const options: BranchOptions = {
    session: params.session,
    branch: params.name,
  };
  
  const result = await gitService.branch(options);
  
  log.debug("Branch created successfully", { 
    session: params.session,
    branch: params.name,
    workdir: result.workdir 
  });
  
  return result;
} 
