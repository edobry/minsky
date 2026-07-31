/**
 * Shared workspace-overview builder (mt#2768 — Tabbed run detail).
 *
 * Extracted from `routes/agents.ts`'s `/api/agents/:id` handler so the SAME
 * enrichment (git log, task title, PR shape) can be reused by the
 * conversation-keyed reverse-join path (`routes/conversations.ts`'s
 * `/api/conversation/:id/overview`) — "one detail component" applies to the
 * backend enrichment logic too, not just the frontend tabs.
 *
 * Every enrichment degrades independently (git log failure, task-service
 * outage, etc. all fall back to safe defaults) — this function never throws;
 * callers only need to handle the case where the SessionRecord itself is
 * missing (a 404 concern that stays with each route).
 */
import { log } from "@minsky/shared/logger";
import type { SessionRecord } from "@minsky/domain/session/types";
import { getServerTaskService } from "./db-providers";
import {
  buildSessionMeta,
  buildPrRef,
  githubRepoWebBase,
  parseGitLog,
  GIT_LOG_FORMAT,
  type SessionDetailMeta,
  type SessionCommitRef,
  type SessionPrRef,
} from "./session-detail";

export interface WorkspaceOverview {
  session: SessionDetailMeta;
  /** Most-recent-first, scoped to THIS session's branch (mt#2768 fix — see resolveCommitRange). */
  commits: SessionCommitRef[];
  pr: SessionPrRef | null;
}

/**
 * Candidate base refs to compute a merge-base against, in preference order.
 * The first ref that resolves wins; none resolving falls back to plain
 * `HEAD` (pre-mt#2768 behavior — traverses full ancestor history).
 */
const BASE_REF_CANDIDATES = ["origin/main", "origin/master", "main", "master"] as const;

/**
 * Resolve the commit RANGE to log, scoped to commits unique to this
 * session's branch (mt#2768 Overview correctness fix).
 *
 * Bug this fixes: a fresh/CREATED workspace whose branch has no commits yet
 * showed INHERITED main-repo history — `git log -n 10` with no range starts
 * from HEAD and walks every ancestor, which is indistinguishable from "10
 * most recent commits on main" when the session branch hasn't diverged.
 *
 * Fix: compute the merge-base against the first resolvable base ref and log
 * `<mergeBase>..HEAD` — commits unique to the session branch. When the
 * session branch has genuinely made no commits since forking, this range is
 * empty, which the caller renders as an explicit "no session commits yet"
 * state rather than inherited history.
 *
 * @returns the git log range argument (`"<mergeBase>..HEAD"` or `"HEAD"` as
 *   a last-resort fallback when no base ref resolves — e.g. a shallow clone
 *   or a repo with no configured remote).
 */
async function resolveCommitRange(
  execFileAsync: (
    cmd: string,
    args: string[],
    opts: { timeout: number; maxBuffer: number }
  ) => Promise<{ stdout: string }>,
  workdir: string
): Promise<string> {
  for (const ref of BASE_REF_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", workdir, "merge-base", "HEAD", ref], {
        timeout: 3_000,
        maxBuffer: 4 * 1024,
      });
      const mergeBase = stdout.trim();
      if (mergeBase) return `${mergeBase}..HEAD`;
    } catch {
      continue;
    }
  }
  return "HEAD";
}

/**
 * Build the `{ session, commits, pr }` enrichment for a resolved SessionRecord.
 * Does NOT resolve the record itself — callers own the 404 concern for a
 * missing session; this function only enriches an already-found record.
 *
 * @param workdir the workspace directory, already resolved by the caller
 *   (record fields first, `provider.getSessionWorkdir()` as fallback — both
 *   existing callers already do this resolution for their OWN 404/liveness
 *   concerns, so it is not repeated here).
 */
export async function buildWorkspaceOverview(
  record: SessionRecord,
  workdir: string | null
): Promise<WorkspaceOverview> {
  const repoWebBase = githubRepoWebBase(record.repoUrl);

  const commitsPromise: Promise<SessionCommitRef[]> = (async () => {
    if (!workdir) return [];
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!existsSync(workdir) || !existsSync(join(workdir, ".git"))) {
      log.debug(`[workspace-overview] commits enrichment skipped — no git workspace at ${workdir}`);
      return [];
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    try {
      const range = await resolveCommitRange(execFileAsync, workdir);
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workdir, "log", `--format=${GIT_LOG_FORMAT}`, "-n", "10", range],
        { timeout: 5_000, maxBuffer: 256 * 1024 }
      );
      return parseGitLog(stdout, repoWebBase);
    } catch (gitErr) {
      const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
      log.debug(`[workspace-overview] commits enrichment degraded — git log failed: ${msg}`);
      return [];
    }
  })();

  const taskTitlePromise: Promise<string | null> = (async () => {
    if (!record.taskId) return null;
    try {
      const taskService = await getServerTaskService();
      if (!taskService) return null;
      const task = await taskService.getTask(record.taskId);
      return task?.title ?? null;
    } catch (titleErr) {
      const msg = titleErr instanceof Error ? titleErr.message : String(titleErr);
      log.debug(`[workspace-overview] task-title enrichment degraded: ${msg}`);
      return null;
    }
  })();

  const [commits, taskTitle] = await Promise.all([commitsPromise, taskTitlePromise]);

  return {
    session: buildSessionMeta(record, taskTitle),
    commits,
    pr: buildPrRef(record),
  };
}
