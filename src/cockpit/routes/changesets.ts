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
  getDefaultChangesetRepoRef,
  getProjectRepoRefBySlug,
  describeServerPersistenceUnavailability,
} from "../db-providers";
import { resolveCockpitProjectScope, ALL_PROJECTS_PARAM } from "../project-scope";
import { changesetIdFor, isChangesetId } from "../changeset-id";
import { resolveChangesetRepoSource, selectSessionForChangeset } from "../changeset-resolution";
import { respondIfDatabaseUnavailable } from "../db-unavailable-response";
import { getLoggableErrorSummary } from "@minsky/domain/schemas/error";
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

    // A changeset id is a PR number, optionally qualified by its repository
    // (`owner/repo#N`, mt#4724 / mt#1207's convention). matchEntityRoute is
    // permissive and accepts any path segment as :id — the server is the
    // authoritative gate.
    //
    // The digits-only alternative is deliberate and not redundant: `0` is not a
    // valid PR number, but this route has answered 404 for it since mt#3096
    // ("a wholly unresolvable id is a 404, not a 500") and that contract is
    // asserted directly. Digit strings therefore stay SYNTACTICALLY acceptable
    // here and fall through to the unresolvable branch below.
    if (!/^[0-9]+$/.test(changesetId) && !isChangesetId(changesetId)) {
      res.status(400).json({
        error: "Invalid changeset id: expected a PR number or owner/repo#number",
      });
      return;
    }

    try {
      // WHICH repo this request names (mt#4724). A PR number is unique only
      // per-repository, so every read below — the live PR, the session
      // enrichment scan, and the CI check-runs — is scoped by it. A bare id
      // with no `?project=` resolves against the DEFAULT project, which is what
      // it has always meant and what keeps already-emitted
      // `minsky://changeset/<n>` links resolving (ADR-029 fixes that form).
      const projectParam = typeof req.query.project === "string" ? req.query.project : undefined;
      const projectQualified = Boolean(projectParam) && projectParam !== ALL_PROJECTS_PARAM;
      const projectRepo = projectQualified
        ? await getProjectRepoRefBySlug(projectParam as string)
        : null;

      // An UNRESOLVABLE explicit qualifier must not fall through to the default
      // project (PR #3455 R1). The fail-open posture `resolveCockpitProjectScope`
      // takes is right for the LIST route, where degrading to ALL_PROJECTS shows
      // MORE rows and the caller can see what it got. Here it would silently
      // return a DIFFERENT PR — the caller asked for project X's PR N and would
      // be handed the default project's PR N, indistinguishable from a correct
      // answer. That is the exact substitution this task exists to remove, so
      // this branch fails closed.
      if (projectQualified && !projectRepo) {
        res.status(404).json({
          error:
            `No repository for project "${projectParam}" — it is not a known project ` +
            `and its slug is not an owner/repo pair, so changeset ${changesetId} cannot ` +
            `be resolved within it.`,
        });
        return;
      }

      const request = resolveChangesetRepoSource({
        changesetId,
        projectRepo,
        defaultRepo: await getDefaultChangesetRepoRef(),
      });
      if (!request) {
        // Reached only by a digit string that is not a PR number (`0`, or a
        // value past MAX_SAFE_INTEGER). Nothing can resolve it, and an
        // unresolvable id is a 404 on this route (mt#3096).
        res.status(404).json({ error: `No changeset found for ${changesetId}` });
        return;
      }
      const { prNumber, repo } = request;
      // The forge adapter is already bound to ONE repo, so it takes the bare PR
      // number — the qualifier lives in the service construction, not the key.
      const prKey = String(prNumber);
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
        const reader = await getServerChangesetService(repo);
        liveChangeset = reader ? await reader.get(prKey) : null;
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
          // Scoped by the resolved repo (mt#4724). This scan used to take the
          // FIRST row whose `pullRequest.number` matched, over an UNSCOPED
          // list — so two projects each holding a PR #1 collided on whichever
          // row the store returned first. The rule now lives in
          // `selectSessionForChangeset`, tested directly.
          const allSessions = await provider.listSessions();
          record = selectSessionForChangeset(allSessions, prNumber, repo);
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
          // Same repo the changeset was read from (mt#4724): a head SHA queried
          // against another repository returns an EMPTY check-run set rather
          // than an error, i.e. an unearned "no checks".
          const checksReader = await getServerChecksReader(repo);
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
      // The DETAIL route, which mt#4086 left behind when it fixed the list
      // route beneath — the sibling degradation block for this endpoint states
      // plainly that "a 500 is a regression" (mt#3096), and it was one.
      if (await respondIfDatabaseUnavailable(res, err, "changesets")) return;
      log.error(
        `[changeset] GET /api/changeset/:id — internal error: ${getLoggableErrorSummary(err)}`
      );
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
        res.status(503).json({
          error: `Session service unavailable — ${await describeServerPersistenceUnavailability()}`,
        });
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
      // The default repo decides which rows keep a BARE changeset id (mt#4724):
      // resolved once for the whole list rather than per row.
      const defaultRepo = await getDefaultChangesetRepoRef();
      type ChangesetItem = {
        pr: NonNullable<ReturnType<typeof buildPrRef>>;
        session: ReturnType<typeof buildSessionMeta>;
        /**
         * The routable id for this changeset — bare for the default project,
         * `owner/repo#N` otherwise. Emitted so the client links to an
         * UNAMBIGUOUS detail route rather than re-deriving a bare PR number
         * that two projects can both claim.
         */
        changesetId: string | null;
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
          return {
            pr,
            session: buildSessionMeta(record, taskTitle),
            changesetId:
              pr.number != null ? changesetIdFor(record.repoUrl, pr.number, defaultRepo) : null,
          };
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
      // A database outage is not an application bug, and this route already has
      // a posture for it: the provider-unavailable branch above answers 503.
      // Reaching the catch with a live provider whose QUERY failed is the same
      // condition one step later, so it gets the same status (mt#4086).
      if (await respondIfDatabaseUnavailable(res, err, "changesets")) return;
      // The cause chain, not just the message: a drizzle failure's own message
      // IS the query text, so a message-only log names the statement and never
      // the reason it failed — which is what made mt#4086 cost a live capture.
      log.error(
        `[changesets] GET /api/changesets — internal error: ${getLoggableErrorSummary(err)}`
      );
      res.status(500).json({ error: "An internal error occurred while fetching changesets." });
    }
  });
}
