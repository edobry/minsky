import { log } from "../../utils/logger";
import { MinskyError } from "../../errors";
import type { SessionProviderInterface } from "../session/types";

export interface PreparePrOptions {
  session?: string;
  repoPath?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  debug?: boolean;
  branchName?: string;
}

export interface PreparePrResult {
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}

export interface PreparePrDependencies {
  sessionDb: SessionProviderInterface;
  execInRepository: (workdir: string, command: string) => Promise<string>;
  getSessionWorkdir: (session: string) => string;
}

export async function preparePr(
  options: PreparePrOptions,
  deps: PreparePrDependencies
): Promise<PreparePrResult> {
  let workdir: string;
  let sourceBranch: string;
  const baseBranch = options.baseBranch || "main";

  // Add debugging for session lookup
  if (options.session) {
    log.debug(`Attempting to look up session in database: ${options.session}`);
  }

  // Determine working directory and current branch
  if (options.session) {
    const record = await deps.sessionDb.getSession(options.session);

    // Add more detailed debugging
    log.debug(
      `Session database lookup result: ${options.session}, found: ${!!record}, recordData: ${record ? JSON.stringify({ repoName: record.repoName, repoUrl: record.repoUrl, taskId: record.taskId }) : "null"}`
    );

    if (!record) {
      throw new MinskyError(
        `Session "${options.session}" not found. ` +
          `The session database (with auto-repair) could not locate this session.\n\n` +
          `💡 Try:\n` +
          `  minsky session list              (see registered sessions)\n` +
          `  minsky session start --task ID   (create a new session)\n`
      );
    }
    workdir = deps.getSessionWorkdir(options.session);

    // Get current branch from repo instead of assuming session ID is branch name
    try {
      sourceBranch = await deps.execInRepository(workdir, "git branch --show-current");
      sourceBranch = sourceBranch.trim();
    } catch (branchError) {
      log.debug("Failed to get current branch, falling back to session branch or session ID", {
        session: options.session,
        error: branchError,
      });
      // Try to use branch from session record, then fall back to session ID
      sourceBranch = record?.branch || options.session;
    }
  } else if (options.repoPath) {
    workdir = options.repoPath;
    try {
      sourceBranch = await deps.execInRepository(workdir, "git branch --show-current");
      sourceBranch = sourceBranch.trim();
    } catch (branchError) {
      throw new MinskyError(`Failed to determine current branch in ${workdir}: ${branchError}`);
    }
  } else {
    throw new MinskyError("Either session or repoPath must be provided");
  }

  // Validate that we have a valid working directory
  try {
    await deps.execInRepository(workdir, "git status");
  } catch (statusError) {
    throw new MinskyError(`Invalid git repository at ${workdir}: ${statusError}`);
  }

  // Create the PR branch name
  const prBranchName = options.branchName || `pr/${sourceBranch}`;

  // Create and checkout the PR branch
  try {
    // First, ensure we're on the source branch
    await deps.execInRepository(workdir, `git checkout ${sourceBranch}`);

    // Create and checkout the PR branch
    await deps.execInRepository(workdir, `git checkout -b ${prBranchName}`);

    log.debug("Created PR branch", {
      sourceBranch,
      prBranch: prBranchName,
      workdir,
    });
  } catch (branchError) {
    // If branch already exists, just switch to it
    try {
      await deps.execInRepository(workdir, `git checkout ${prBranchName}`);
      log.debug("Switched to existing PR branch", {
        prBranch: prBranchName,
        workdir,
      });
    } catch (checkoutError) {
      throw new MinskyError(
        `Failed to create or checkout PR branch ${prBranchName}: ${checkoutError}`
      );
    }
  }

  return {
    prBranch: prBranchName,
    baseBranch,
    title: options.title,
    body: options.body,
  };
}
