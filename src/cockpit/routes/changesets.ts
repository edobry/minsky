/**
 * Cockpit changeset (PR) routes (mt#2615 — extracted from server.ts, mt#1920 / mt#2535).
 *
 *   GET /api/changeset/:id — PR/changeset detail for the drill-down page (mt#2535)
 *   GET /api/changesets    — active (open/draft) PRs across sessions (mt#1920)
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import {
  getServerSessionProvider,
  getServerTaskService,
  getServerChangesetService,
  getServerChecksReader,
} from "../db-providers";
import { resolveCockpitProjectScope } from "../project-scope";
import type { Changeset } from "@minsky/domain/changeset/types";
import type { SessionRecord } from "@minsky/domain/session/types";
import type {
  SessionCommitRef,
  ChangesetChecksSummary,
  ChangesetChecksUnavailableReason,
} from "../session-detail";

/** Message text for a caught unknown. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Mount /api/changeset/:id and /api/changesets on `app`. */
export function mountChangesetRoutes(app: express.Express): void {
  /**
   * GET /api/changeset/:id — PR/changeset detail for the drill-down page
   * (mt#2535, re-sourced by mt#3096).
   *
   * The changeset id is the VCS-agnostic abstraction keyed to a PR number.
   *
   * SOURCING (mt#3096): the LIVE PR is the primary source and the session
   * record is OPTIONAL enrichment — the inverse of the original design, which
   * resolved a changeset by scanning every session row for a matching
   * `pullRequest.number` and then built the whole view from that record's
   * cached snapshot. That snapshot's `title` is almost always null, so the page
   * rendered a literal "(no title)" for PRs that plainly have one; it also
   * meant a merged PR whose session had been cleaned up 404'd even though the
   * PR was real, and a single session-store hiccup 500'd the entire page.
   *
   * Each source degrades INDEPENDENTLY:
   *   - live PR unavailable (no credential / forge error) -> fall back to the
   *     session snapshot, with the shared title-fallback chain.
   *   - session store unavailable -> still render everything the live PR knows.
   *   - both unavailable -> 404.
   */
  app.get("/api/changeset/:id", async (req, res) => {
    const rawId = req.params.id;
    if (!rawId) {
      res.status(400).json({ error: "Changeset ID required" });
      return;
    }
    const changesetId = decodeURIComponent(rawId);

    // Canonical changeset id is a PR number (positive integer string).
    // matchEntityRoute is permissive and accepts any path segment as :id —
    // the server is the authoritative gate.
    if (!/^[0-9]+$/.test(changesetId)) {
      res.status(400).json({ error: "Invalid changeset id: expected a PR number" });
      return;
    }
    const prNumber = parseInt(changesetId, 10);

    try {
      const {
        buildSessionMeta,
        buildPrRef,
        githubRepoWebBase,
        parseGitLog,
        GIT_LOG_FORMAT,
        prRefFromChangeset,
        liveDetailFromChangeset,
        repoWebBaseFromPrUrl,
        commitsFromChangeset,
      } = await import("../session-detail");

      // ---------------------------------------------------------------
      // (1) LIVE PR — primary source. Degrades to null, never throws.
      // ---------------------------------------------------------------
      let liveChangeset: Changeset | null = null;
      try {
        const reader = await getServerChangesetService();
        liveChangeset = reader ? await reader.get(changesetId) : null;
        if (!reader) {
          log.debug(
            `[changeset] no live changeset reader for #${changesetId} — rendering from session snapshot`
          );
        }
      } catch (liveErr) {
        log.debug(`[changeset] live PR fetch degraded for #${changesetId}: ${errText(liveErr)}`);
      }

      // ---------------------------------------------------------------
      // (2) SESSION RECORD — optional enrichment (linked task, workspace,
      // local commits). A failure here must not take down the live path.
      // ---------------------------------------------------------------
      let provider: Awaited<ReturnType<typeof getServerSessionProvider>> = null;
      let record: SessionRecord | null = null;
      try {
        provider = await getServerSessionProvider();
        if (provider) {
          const allSessions = await provider.listSessions();
          record = allSessions.find((s) => s.pullRequest?.number === prNumber) ?? null;
        }
      } catch (sessionErr) {
        log.debug(
          `[changeset] session enrichment degraded for #${changesetId}: ${errText(sessionErr)}`
        );
      }

      // Only a wholly unresolvable id is a 404.
      if (!liveChangeset && !record) {
        res.status(404).json({ error: `No changeset found for ${changesetId}` });
        return;
      }

      // Workspace dir: record fields first, provider lookup as fallback.
      let workdir: string | null = null;
      if (record) {
        workdir = record.workspacePath ?? record.sessionPath ?? null;
        if (!workdir && provider) {
          try {
            workdir = await provider.getSessionWorkdir(record.sessionId);
          } catch {
            workdir = null;
          }
        }
      }

      const repoWebBase = record
        ? githubRepoWebBase(record.repoUrl)
        : repoWebBaseFromPrUrl(liveChangeset?.metadata?.github?.htmlUrl);

      // Enrichments degrade independently per the agents endpoint pattern.
      const commitsPromise: Promise<SessionCommitRef[]> = (async () => {
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
          log.debug(`[changeset] commits enrichment degraded — git log failed: ${errText(gitErr)}`);
          return [];
        }
      })();

      const taskTitlePromise: Promise<string | null> = (async () => {
        if (!record?.taskId) return null;
        try {
          const taskService = await getServerTaskService();
          if (!taskService) return null;
          const task = await taskService.getTask(record.taskId);
          return task?.title ?? null;
        } catch (titleErr) {
          log.debug(`[changeset] task-title enrichment degraded: ${errText(titleErr)}`);
          return null;
        }
      })();

      const [localCommits, taskTitle] = await Promise.all([commitsPromise, taskTitlePromise]);

      // ---------------------------------------------------------------
      // (3) CI CHECK-RUNS (mt#3097) — keyed on the live PR's head SHA.
      // Degrades to null, never throws. The REASON is carried alongside:
      // "no commit to check" and "the query failed" are different facts, and
      // reporting the second when the first is true is a false statement
      // (PR #2233 R1).
      // ---------------------------------------------------------------
      let checks: ChangesetChecksSummary | null = null;
      let checksUnavailableReason: ChangesetChecksUnavailableReason | null = null;
      const headSha = liveChangeset?.metadata?.github?.headSha;
      if (!headSha) {
        checksUnavailableReason = "no-commit";
      } else {
        try {
          const checksReader = await getServerChecksReader();
          if (!checksReader) {
            checksUnavailableReason = "not-configured";
          } else {
            const result = await checksReader(headSha);
            checks = {
              allPassed: result.allPassed,
              total: result.summary.total,
              passed: result.summary.passed,
              failed: result.summary.failed,
              pending: result.summary.pending,
              checks: result.checks,
            };
          }
        } catch (checksErr) {
          checksUnavailableReason = "fetch-failed";
          log.debug(
            `[changeset] check-runs enrichment degraded for #${changesetId}: ${errText(checksErr)}`
          );
        }
      }

      // PR block: live when available, else the session snapshot.
      const snapshotPr = record ? buildPrRef(record) : null;
      const pr = liveChangeset
        ? prRefFromChangeset(liveChangeset, record?.prApproved ?? null)
        : snapshotPr;

      if (!pr) {
        // A session matched but carries no PR data, and there is no live PR.
        res.status(404).json({ error: `No PR data for changeset ${changesetId}` });
        return;
      }

      // Prefer local git commits (they reflect the working branch); fall back
      // to forge-sourced commits when there is no local workspace.
      const commits =
        localCommits.length > 0
          ? localCommits
          : liveChangeset
            ? commitsFromChangeset(liveChangeset, repoWebBase)
            : [];

      res.json({
        pr,
        session: record ? buildSessionMeta(record, taskTitle) : null,
        commits,
        detail: liveChangeset ? liveDetailFromChangeset(liveChangeset) : null,
        checks,
        checksUnavailableReason,
      });
    } catch (err) {
      log.error(`[changeset] GET /api/changeset/:id — internal error: ${errText(err)}`);
      res.status(500).json({ error: "An internal error occurred while fetching the changeset." });
    }
  });

  /** GET /api/changesets — active (open/draft) PRs across sessions (mt#1920).
   * Session-record path only — changeset_list adapter unavailable in all envs.
   *
   * Query params:
   *   ?project=<slug> — scope to one project (mt#2418); resolved to a
   *   project uuid via `resolveCockpitProjectScope`. Omitted/`"all"` ->
   *   ALL_PROJECTS (unscoped — the pre-mt#2418 behavior). */
  app.get("/api/changesets", async (req, res) => {
    try {
      const provider = await getServerSessionProvider();
      if (!provider) {
        res.status(503).json({ error: "Session service unavailable" });
        return;
      }
      const { buildSessionMeta, buildPrRef, compareChangesetsByRecency } = await import(
        "../session-detail"
      );
      // resolveCockpitProjectScope owns its own db-fetch and never throws
      // (fail-open to ALL_PROJECTS on any resolution failure — PR #2056 R1)
      // so a scoping problem can never take this route down.
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectScope = await resolveCockpitProjectScope(projectParam);
      const allSessions = await provider.listSessions({ projectScope });
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
