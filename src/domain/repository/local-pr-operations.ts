/**
 * Local Git PR lifecycle operations extracted from LocalGitBackend.
 *
 * Contains: createPullRequest, updatePullRequest, mergePullRequest,
 * getPullRequestDetails, getPullRequestDiff.
 *
 * Each function receives its dependencies explicitly (sessionDB helper,
 * workdir resolver) so the main class stays a thin delegation layer.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { execGitWithTimeout } from "../../utils/git-exec";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import {
  createPreparedMergeCommitPR,
  mergePreparedMergeCommitPR,
  type PreparedMergeCommitOptions,
  type PreparedMergeCommitMergeOptions,
} from "../git/prepared-merge-commit-workflow";
import type { SessionProviderInterface } from "../session";
import type { PRInfo, MergeInfo } from "./index";

const execAsync = promisify(exec);

// ── Shared context passed to every function ──────────────────────────────

export interface LocalContext {
  /** Resolve the workdir path for a named session. */
  getSessionWorkdir(session: string): string;
  /** Lazy accessor for the session DB. */
  getSessionDB(): Promise<SessionProviderInterface>;
}

// ── createPullRequest ────────────────────────────────────────────────────

/**
 * Create a pull request using the prepared merge commit workflow.
 */
export async function createPullRequest(
  ctx: LocalContext,
  title: string,
  body: string,
  sourceBranch: string,
  baseBranch: string = "main",
  session?: string,
  _draft?: boolean
): Promise<PRInfo> {
  let workdir: string;

  if (session) {
    const sessionDB = await ctx.getSessionDB();
    const record = await sessionDB.getSession(session);
    if (!record) {
      throw new MinskyError(`Session '${session}' not found in database`);
    }
    workdir = ctx.getSessionWorkdir(session);
  } else {
    workdir = process.cwd();
  }

  const options: PreparedMergeCommitOptions = {
    title,
    body,
    sourceBranch,
    baseBranch,
    workdir,
    session,
  };

  const prInfo = await createPreparedMergeCommitPR(options);

  // Record PR branch + commit hash on the session
  if (session) {
    try {
      const sessionDB = await ctx.getSessionDB();
      const sessionRecord = await sessionDB.getSession(session);
      if (sessionRecord) {
        const prBranchName =
          typeof prInfo.number === "string" ? String(prInfo.number) : `pr/${session}`;
        const workdirPath = ctx.getSessionWorkdir(session);
        const { stdout } = await execAsync(`git -C ${workdirPath} rev-parse ${prBranchName}`);
        const commitHash = stdout.trim();
        await sessionDB.updateSession(session, {
          ...sessionRecord,
          prBranch: prBranchName,
          prState: {
            branchName: prBranchName,
            commitHash,
            lastChecked: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      log.debug("Local backend: unable to record PR commit hash", {
        error: getErrorMessage(err as any),
        session,
      });
    }
  }

  return prInfo;
}

// ── updatePullRequest ────────────────────────────────────────────────────

/**
 * Update an existing pull request (local backend).
 * Delegates to the session PR command which handles prepared merge commit updates.
 */
export async function updatePullRequest(
  ctx: LocalContext,
  options: {
    prIdentifier?: string | number;
    title?: string;
    body?: string;
    session?: string;
  }
): Promise<PRInfo> {
  if (!options.session) {
    throw new MinskyError("Session is required for local repository PR updates");
  }

  const sessionDB = await ctx.getSessionDB();
  const sessionRecord = await sessionDB.getSession(options.session);
  if (!sessionRecord?.prBranch) {
    throw new MinskyError(`No PR found for session '${options.session}'`);
  }

  const { sessionPr } = await import("../session/commands/pr-command");

  await sessionPr(
    {
      sessionName: options.session!,
      title: options.title ?? "Update PR",
      body: options.body,
      skipConflictCheck: false,
      noStatusUpdate: true,
      autoResolveDeleteConflicts: false,
      debug: false,
      draft: false,
    },
    { interface: "cli" }
  );

  return {
    number: sessionRecord.prBranch || "unknown",
    url: sessionRecord.prBranch || "local",
    state: "open",
    metadata: {
      backend: "local",
      workdir: ctx.getSessionWorkdir(options.session),
    },
  };
}

// ── mergePullRequest ─────────────────────────────────────────────────────

/**
 * Merge a pull request using the prepared merge commit workflow.
 */
export async function mergePullRequest(
  ctx: LocalContext,
  prIdentifier: string | number,
  session?: string
): Promise<MergeInfo> {
  let workdir: string;

  if (session) {
    const sessionDB = await ctx.getSessionDB();
    const record = await sessionDB.getSession(session);
    if (!record) {
      throw new MinskyError(`Session '${session}' not found in database`);
    }
    // Use the main repository (repoUrl) — PR branches live there, not in the
    // session workspace which is just a temporary development copy.
    workdir = record.repoUrl;
  } else {
    workdir = process.cwd();
  }

  const mergeOptions: PreparedMergeCommitMergeOptions = {
    prIdentifier,
    workdir,
    session,
  };

  return await mergePreparedMergeCommitPR(mergeOptions);
}

// ── getPullRequestDetails ────────────────────────────────────────────────

/**
 * Retrieve PR details for the local backend.
 * PRs are represented by branches; metadata is stored in session records.
 */
export async function getPullRequestDetails(
  ctx: LocalContext,
  options: { prIdentifier?: string | number; session?: string }
): Promise<{
  number?: number | string;
  url?: string;
  state?: string;
  title?: string;
  body?: string;
  headBranch?: string;
  baseBranch?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
}> {
  let sessionName: string | undefined = options.session;

  if (!sessionName && options.prIdentifier) {
    const prId = String(options.prIdentifier);
    const sessionDB = await ctx.getSessionDB();
    const sessions = await sessionDB.listSessions();
    const record = sessions.find((s) => s.prBranch === prId || `pr/${s.session}` === prId);
    sessionName = record?.session;
  }

  if (!sessionName) {
    throw new MinskyError("Local backend requires session or prIdentifier to resolve PR details");
  }

  const sessionDB = await ctx.getSessionDB();
  const record = await sessionDB.getSession(sessionName);
  if (!record) {
    throw new MinskyError(`Session '${sessionName}' not found`);
  }

  const number = record.prBranch || `pr/${sessionName}`;
  const prInfo = record.pullRequest as any;
  return {
    number,
    url: number,
    state: record.prApproved ? "approved" : "open",
    title: prInfo?.title,
    body: prInfo?.body,
    headBranch: number,
    baseBranch: prInfo?.baseBranch || "main",
    author: undefined,
    createdAt: prInfo?.createdAt,
    updatedAt: prInfo?.updatedAt,
    mergedAt: prInfo?.mergedAt,
  };
}

// ── getPullRequestDiff ───────────────────────────────────────────────────

/**
 * Retrieve PR diff and optional stats for the local backend.
 */
export async function getPullRequestDiff(
  ctx: LocalContext,
  options: { prIdentifier?: string | number; session?: string }
): Promise<{
  diff: string;
  stats?: { filesChanged: number; insertions: number; deletions: number };
}> {
  let sessionName: string | undefined = options.session;
  let prBranch: string | undefined;

  if (!sessionName && options.prIdentifier) {
    const prId = String(options.prIdentifier);
    const sessionDB = await ctx.getSessionDB();
    const sessions = await sessionDB.listSessions();
    const record = sessions.find((s) => s.prBranch === prId || `pr/${s.session}` === prId);
    sessionName = record?.session;
    prBranch = prId;
  }

  if (!sessionName) {
    throw new MinskyError("Local backend requires session or prIdentifier to resolve PR diff");
  }

  const workdir = ctx.getSessionWorkdir(sessionName);
  const baseBranch = "main";

  if (!prBranch) {
    const sessionDB = await ctx.getSessionDB();
    const sessionRecord = await sessionDB.getSession(sessionName);
    prBranch = sessionRecord?.prBranch || `pr/${sessionName}`;
  }

  await execGitWithTimeout("fetch", "fetch origin", { workdir });

  const diff = await execGitWithTimeout("diff", `diff origin/${baseBranch}...origin/${prBranch}`, {
    workdir,
  });

  const shortstat = await execGitWithTimeout(
    "diff-shortstat",
    `diff --shortstat origin/${baseBranch}...origin/${prBranch}`,
    { workdir }
  );

  const match = String(shortstat).match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
  );
  const stats = match
    ? {
        filesChanged: parseInt(match[1] || "0", 10),
        insertions: parseInt(match[2] || "0", 10),
        deletions: parseInt(match[3] || "0", 10),
      }
    : undefined;

  return { diff: String(diff), stats };
}
