/**
 * Cockpit changeset (PR) routes (mt#2615 — extracted from server.ts, mt#1920 / mt#2535).
 *
 *   GET /api/changeset/:id — PR/changeset detail for the drill-down page (mt#2535)
 *   GET /api/changesets    — active (open/draft) PRs across sessions (mt#1920)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getServerSessionProvider, getServerTaskService } from "../db-providers";

/** Mount /api/changeset/:id and /api/changesets on `app`. */
export function mountChangesetRoutes(app: express.Express): void {
  /**
   * GET /api/changeset/:id — PR/changeset detail for the drill-down page (mt#2535).
   *
   * The changeset id is the VCS-agnostic abstraction keyed to a PR number
   * (github-pr adapter). This endpoint resolves the id to a Minsky session record
   * whose pullRequest.number matches, then returns pr + session + commits.
   *
   * Returns: { pr: SessionPrRef, session: SessionDetailMeta, commits: SessionCommitRef[] }
   * Every enrichment degrades independently — only a wholly unresolvable id is a 404.
   *
   * IMPORTANT: changeset_list / changeset_get (github-pr changeset adapter) is NOT
   * configured in all environments. This endpoint uses the session-record path
   * (list sessions, match on pullRequest.number) to avoid that dependency.
   */
  app.get("/api/changeset/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Changeset ID required" });
      return;
    }
    const changesetId = decodeURIComponent(rawId);

    // Canonical changeset id is a PR number (positive integer string).
    // Reject non-numeric ids immediately with 400 so the client ERROR branch
    // fires (not the not-found branch). matchEntityRoute is permissive and
    // accepts any path segment as :id — the server is the authoritative gate.
    if (!/^[0-9]+$/.test(changesetId)) {
      res.status(400).json({ error: "Invalid changeset id: expected a PR number" });
      return;
    }

    try {
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({
          error: "Session service unavailable — persistence provider not ready",
        });
        return;
      }

      // Resolve changeset id to a session: scan all sessions and find the one
      // whose pullRequest.number matches. O(N) over sessions — deliberate
      // local-scale assumption (cockpit is single-operator; session counts
      // are typically <100). A PR-number→session index would be the
      // optimization if this ever needs to scale.
      const prNumber = parseInt(changesetId, 10);
      const allSessions = await provider.listSessions();
      // prNumber is guaranteed a valid integer here — the regex guard above
      // ensures changesetId is all digits, so parseInt is infallible.
      const record = allSessions.find((s) => s.pullRequest?.number === prNumber);

      if (!record) {
        res.status(404).json({
          error: `No session found for changeset ${changesetId}`,
        });
        return;
      }

      const { buildSessionMeta, buildPrRef, githubRepoWebBase, parseGitLog, GIT_LOG_FORMAT } =
        await import("../session-detail");

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = record.workspacePath ?? record.sessionPath ?? null;
      if (!workdir) {
        try {
          workdir = await provider.getSessionWorkdir(record.sessionId);
        } catch {
          workdir = null;
        }
      }

      const repoWebBase = githubRepoWebBase(record.repoUrl);

      // Enrichments degrade independently per the agents endpoint pattern.
      const commitsPromise: Promise<ReturnType<typeof parseGitLog>> = (async () => {
        if (!workdir) return [];
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        if (!existsSync(workdir) || !existsSync(join(workdir, ".git"))) {
          log.debug(`[changeset] commits enrichment skipped — no git workspace at ${workdir}`);
          return [];
        }
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", workdir, "log", `--format=${GIT_LOG_FORMAT}`, "-n", "10"],
            { timeout: 5_000, maxBuffer: 256 * 1024 }
          );
          return parseGitLog(stdout, repoWebBase);
        } catch (gitErr) {
          const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
          log.debug(`[changeset] commits enrichment degraded — git log failed: ${msg}`);
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
          log.debug(`[changeset] task-title enrichment degraded: ${msg}`);
          return null;
        }
      })();

      const [commits, taskTitle] = await Promise.all([commitsPromise, taskTitlePromise]);

      const pr = buildPrRef(record);
      if (!pr) {
        // Session matched on PR number but buildPrRef returned null — degenerate record.
        res.status(404).json({ error: `No PR data for changeset ${changesetId}` });
        return;
      }

      res.json({
        pr,
        session: buildSessionMeta(record, taskTitle),
        commits,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[changeset] GET /api/changeset/:id — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while fetching the changeset." });
    }
  });

  /** GET /api/changesets — active (open/draft) PRs across sessions (mt#1920).
   * Session-record path only — changeset_list adapter unavailable in all envs. */
  app.get("/api/changesets", async (_req, res) => {
    try {
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({ error: "Session service unavailable" });
        return;
      }
      const { buildSessionMeta, buildPrRef, compareChangesetsByRecency } = await import(
        "../session-detail"
      );
      const allSessions = await provider.listSessions();
      const active = allSessions.filter((s) => {
        const pr = buildPrRef(s);
        return pr !== null && (pr.state === "open" || pr.state === "draft");
      });
      const taskService = await getServerTaskService().catch(() => null);
      type ChangesetItem = {
        pr: NonNullable<ReturnType<typeof buildPrRef>>;
        session: ReturnType<typeof buildSessionMeta>;
      };
      const settled = await Promise.allSettled(
        active.map(async (record): Promise<ChangesetItem> => {
          let taskTitle: string | null = null;
          if (record.taskId && taskService) {
            try {
              taskTitle = (await taskService.getTask(record.taskId))?.title ?? null;
            } catch {
              /* degrade */
            }
          }
          const pr = buildPrRef(record);
          if (!pr) throw new Error(`No PR ref for session ${record.sessionId}`);
          return { pr, session: buildSessionMeta(record, taskTitle) };
        })
      );
      const changesets = (
        settled.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<ChangesetItem>[]
      )
        .map((r) => r.value)
        // Newest-first by PR-recency proxy (lastActivityAt ?? createdAt), NOT by
        // session.createdAt — see compareChangesetsByRecency JSDoc (mt#1920 R1).
        .sort(compareChangesetsByRecency);
      res.json({ changesets });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[changesets] GET /api/changesets — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while fetching changesets." });
    }
  });
}
