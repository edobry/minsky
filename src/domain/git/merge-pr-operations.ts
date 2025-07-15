import { normalizeRepoName } from "../repo-utils";
import { MergePrOptions, MergePrResult } from "./types";

export interface MergePrDependencies {
  execInRepository: (workdir: string, command: string) => Promise<string>;
  getSession: (name: string) => Promise<any>;
  getSessionWorkdir: (session: string) => string;
}

/**
 * Merge a PR branch into the base branch
 */
export async function mergePrImpl(
  options: MergePrOptions,
  deps: MergePrDependencies
): Promise<MergePrResult> {
  let workdir: string;
  const baseBranch = options.baseBranch || "main";

  // 1. Determine working directory
  if (options.session) {
    const record = await deps.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    workdir = deps.getSessionWorkdir(options.session);
  } else if (options.repoPath) {
    workdir = options.repoPath;
  } else {
    // Try to infer from current directory
    workdir = process.cwd();
  }

  // 2. Make sure we're on the base branch
  await deps.execInRepository(workdir, `git checkout ${baseBranch}`);

  // 3. Make sure we have the latest changes
  await deps.execInRepository(workdir, `git pull origin ${baseBranch}`);

  // 4. Merge the PR branch
  await deps.execInRepository(workdir, `git merge --no-ff ${options.prBranch}`);

  // 5. Get the commit hash of the merge
  const commitHash = (await deps.execInRepository(workdir, "git rev-parse HEAD")).trim();

  // 6. Get merge date and author
  const mergeDate = new Date().toISOString();
  const mergedBy = (await deps.execInRepository(workdir, "git config user.name")).trim();

  // 7. Push the merge to the remote
  await deps.execInRepository(workdir, `git push origin ${baseBranch}`);

  // 8. Delete the PR branch from the remote
  await deps.execInRepository(workdir, `git push origin --delete ${options.prBranch}`);

  return {
    prBranch: options.prBranch,
    baseBranch,
    commitHash,
    mergeDate,
    mergedBy,
  };
} 
