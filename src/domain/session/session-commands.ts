/**
 * Session Commands
 *
 * Session operations that accept session parameters.
 */

import { MinskyError, NothingToCommitError } from "../../errors/index";
import { log } from "../../utils/logger";
import type { AskRepository } from "../ask/repository";
import { checkFreshnessCas, cleanupFreshnessMarker } from "./freshness-marker";

/**
 * Error thrown when the branch-freshness CAS check (mt#1522) detects that
 * `origin/main` advanced between the freshness hook's allow decision and
 * `session_commit`'s push. Defined here (rather than in `freshness-marker.ts`)
 * so the marker module stays free of `errors/` imports — that module is also
 * imported by the `.claude/hooks/check-branch-fresh.ts` hook for its write
 * helper, and dragging app-domain transitive deps into the hook is a
 * regression risk per PR #963 R2 BLOCKING #2.
 *
 * Carries a stable `code` so UX/policy/telemetry layers can distinguish a
 * CAS-prevented push from other commit failures programmatically.
 */
export class FreshnessCasError extends MinskyError {
  readonly code: "FRESHNESS_CAS_FAILED" = "FRESHNESS_CAS_FAILED";
  constructor(
    message: string,
    public readonly capturedSha: string,
    public readonly currentSha: string,
    public readonly mainRef: string
  ) {
    super(message);
  }
}

/**
 * Session PR creation parameters
 */
export interface SessionPrParams {
  session: string;
  title?: string;
  body?: string;
  bodyPath?: string;
  noStatusUpdate?: boolean;

  skipConflictCheck?: boolean;
  autoResolveDeleteConflicts?: boolean;
  debug?: boolean;
}

// ❌ DELETED: sessionPr() wrapper function - redundant duplicate
// This function was a wrapper around sessionPrFromParams (legacy implementation).
// All callers should use the modern sessionPr() from ./commands/pr-command.ts instead.

/**
 * Session update interface with explicit parameters
 */
export interface SessionUpdateParams {
  session: string; // ✅ ALWAYS required
  branch?: string;
  force?: boolean;
  dryRun?: boolean;
  noStash?: boolean;
  noPush?: boolean;
  skipConflictCheck?: boolean;
  skipIfAlreadyMerged?: boolean;
  autoResolveDeleteConflicts?: boolean;
}

/**
 * Pure domain interface for session approval
 */
export interface SessionApproveParams {
  session: string; // ✅ ALWAYS required
}

/**
 * Pure session approve domain function
 */
export async function pureSessionApprove(
  params: SessionApproveParams,
  sessionProvider: import("./types").SessionProviderInterface
): Promise<{
  success: boolean;
  message: string;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Pure session approve command", { session: params.session });

  const { approveSessionPr } = await import("./session-approval-operations.js");

  try {
    const _result = await approveSessionPr(
      {
        session: params.session,
      },
      { sessionDB: sessionProvider }
    );

    return {
      success: true,
      message: "Session approved successfully",
    };
  } catch (error) {
    log.debug("Pure session approve failed", {
      error: error instanceof Error ? error.message : String(error),
      session: params.session,
    });
    throw error;
  }
}

/**
 * Session commit command - commits and pushes changes within a specific session
 *
 * Note: Always pushes after commit - in session context these operations should be atomic
 */
export async function sessionCommit(
  params: {
    session: string;
    message: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  },
  sessionProvider: import("./types").SessionProviderInterface,
  askRepository?: AskRepository
): Promise<{
  success: boolean;
  nothingToCommit?: boolean;
  commitHash: string | null;
  shortHash?: string;
  subject?: string;
  branch?: string;
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;
  message: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  files?: Array<{ path: string; status: string }>;
  pushed: boolean;
}> {
  if (!params.session) {
    throw new MinskyError("Session parameter is required", "VALIDATION_ERROR");
  }

  log.debug("Session commit command", {
    session: params.session,
    message: params.message,
  });

  // Enforce merged-PR-freeze invariant BEFORE Ask emission.
  // Design rationale: assertSessionMutable fires first by design. Frozen sessions
  // (those whose PR has been merged) cannot commit, so capturing them as Ask events
  // would route non-events through the policy system. ADR §Detection records actual
  // commits, not attempts on frozen sessions.
  //
  // Reviewer note: R1 and R2 both raised "emit before mutable check" as a finding.
  // That finding is explicitly dismissed: the ordering is intentional. Frozen sessions
  // cannot produce real commits; an Ask emitted for one would be a false positive.
  const { assertSessionMutable } = await import("./session-mutability.js");
  const sessionRecordForFreeze = await sessionProvider.getSession(params.session);
  if (sessionRecordForFreeze) {
    assertSessionMutable(sessionRecordForFreeze, "commit changes");
  }

  const { commitChangesFromParams, pushFromParams, createGitService } = await import("../git");

  // Resolve session to repo path at this boundary (needed for clean-tree check below)
  const workdir = await sessionProvider.getSessionWorkdir(params.session);

  // mt#1522 / PR #963 R1 BLOCKING #5: marker cleanup must run on EVERY exit
  // path of sessionCommit (clean-tree early return, NothingToCommitError
  // early return, commit failure, CAS abort, push failure, success). Wrapping
  // the entire post-workdir body in try/finally with cleanup in finally
  // gives that guarantee — the previous inline cleanup only after a
  // successful CAS check left stale markers on early returns.
  try {
    // Detect clean working tree up front — skip Ask emission and return early when
    // there is nothing to commit. ADR §Detection: "every agent-initiated commit" means
    // actual commits, not attempts on a clean tree.
    //
    // Carve-out: when params.amend is true, the commit may legitimately update only
    // the commit message without new file changes. In that case the working tree is
    // clean by design, so we must NOT short-circuit — the amend must be allowed to
    // proceed even when hasUncommittedChanges returns false.
    const sessionIdToUse = params.session;
    let isCleanTree = false;
    try {
      const gitService = createGitService();
      const hasChanges = await gitService.hasUncommittedChanges(workdir);
      isCleanTree = !hasChanges;
    } catch (probeErr) {
      // If we cannot determine tree state (e.g. not a git repo yet), let the
      // downstream commit attempt proceed and handle NothingToCommitError there.
      // Surface the probe failure (don't silently swallow): if the tree turns out
      // to actually be clean, the Ask emitted below is a benign false positive
      // for that rare path, but operators need visibility into why detection failed.
      log.warn(
        `[session.commit] hasUncommittedChanges probe failed; proceeding with commit attempt: ${
          probeErr instanceof Error ? probeErr.message : String(probeErr)
        }`
      );
    }

    if (!params.amend && isCleanTree) {
      log.debug("Nothing to commit in session (clean working tree)", { session: params.session });
      return {
        success: true,
        nothingToCommit: true,
        commitHash: null,
        message: "Nothing to commit, working tree clean",
        pushed: false,
      };
    }

    // Emit authorization.approve Ask (best-effort — never blocks the commit)
    // Only reaches here when there are actual changes to commit.
    if (askRepository) {
      try {
        const requestor =
          sessionRecordForFreeze?.agentId ?? `minsky.session-commit:session:${sessionIdToUse}`;
        await askRepository.create({
          kind: "authorization.approve",
          classifierVersion: "v1",
          requestor,
          parentTaskId: sessionRecordForFreeze?.taskId,
          parentSessionId: sessionRecordForFreeze?.sessionId,
          title: `Commit authorization: ${params.message.slice(0, 80)}`,
          question: `Authorize commit in session ${params.session}: "${params.message}"`,
          metadata: {
            commitMessage: params.message,
            stagedFiles: params.all ? "all" : "manual-staged",
          },
        });
      } catch (askErr: unknown) {
        log.warn("sessionCommit: failed to emit authorization.approve Ask (best-effort)", {
          session: params.session,
          error: askErr instanceof Error ? askErr.message : String(askErr),
        });
      }
    }

    try {
      // Commit changes using session-scoped git command
      let commitResult!: { commitHash: string; message: string };
      try {
        commitResult = await commitChangesFromParams({
          message: params.message,
          repo: workdir,
          all: params.all,
          amend: params.amend,
          noStage: params.noStage,
        });
      } catch (commitErr: unknown) {
        // Handle "nothing to commit" gracefully — not an error condition
        if (commitErr instanceof NothingToCommitError) {
          log.debug("Nothing to commit in session", { session: params.session });
          return {
            success: true,
            nothingToCommit: true,
            commitHash: null,
            message: "Nothing to commit, working tree clean",
            pushed: false,
          };
        }
        throw commitErr;
      }

      // mt#1522: CAS check on origin/main SHA before push.
      //
      // The branch-freshness hook (mt#1483) captures origin/main's SHA at
      // allow time and writes it to `.git/.minsky-freshness-sha`. Here we
      // re-fetch and verify the SHA hasn't advanced. If it has, the agent
      // would build on stale base — same shape of bug the freshness hook
      // exists to prevent, just at a smaller (~seconds) time scale.
      //
      // §7b TOCTOU enumeration on this CAS pattern:
      //   - Read atomicity: marker is one read; current-SHA is one
      //     `git rev-parse` after fetch. PASS.
      //   - Decision-action gap: between this CAS pass and the push that
      //     follows, origin/main can advance again. ACCEPT — irreducible
      //     (no remote locking on origin/main without server-side
      //     enforcement) AND FF-conflict-preserving (push to
      //     origin/<branch> doesn't conflict with origin/main advances).
      //     The push-duration window is ms-class, orders of magnitude
      //     smaller than the seconds-class gap we're closing.
      //   - Stale-read at read time: forced fresh `git fetch` before SHA
      //     resolve. PASS.
      //
      // When MINSKY_SKIP_FRESHNESS=1, the hook exits before writing a
      // marker; checkFreshnessCas reads no marker and bypasses, mirroring
      // the override semantics through to push.
      const casGitService = createGitService();
      const casResult = await checkFreshnessCas(workdir, {
        fetchOrigin: async (dir) => {
          try {
            await casGitService.execInRepository(dir, "git fetch origin --prune --no-tags --quiet");
            return true;
          } catch {
            return false;
          }
        },
        resolveRefSha: async (dir, ref) => {
          try {
            // Defense-in-depth (PR #963 R2 BLOCKING #1): `--` separator
            // prevents git from interpreting `ref` as an option even if
            // a future regex regression were to admit a leading-`-`
            // value. SAFE_REF_RE already forbids leading `-`; this
            // keeps the call safe under any validator drift.
            const out = await casGitService.execInRepository(dir, `git rev-parse -- "${ref}"`);
            const sha = out.trim();
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
          } catch {
            return null;
          }
        },
      });
      // Cleanup happens unconditionally in the outer `finally` block — see
      // the bottom of sessionCommit. We don't clean up here so the casResult
      // remains the source of truth for the throw decision.
      if (!casResult.ok) {
        throw new FreshnessCasError(
          `Branch-freshness CAS check failed: ${casResult.reason ?? "(no reason)"}`,
          casResult.capturedSha ?? "(unknown)",
          casResult.currentSha ?? "(unknown)",
          // marker.mainRef captured here would require re-reading the marker;
          // skip in favor of the reason field which already names the ref.
          ""
        );
      }

      // Always push changes in session context - commit and push should be atomic
      const pushResult = await pushFromParams({
        repo: workdir,
      });

      // Collect commit metadata and changed files
      const gitService = createGitService();

      // Branch name
      let branch: string | undefined;
      try {
        branch = await gitService.getCurrentBranch(workdir);
      } catch (err) {
        log.debug("Failed to get branch name", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Author, subject, timestamp, short hash
      let shortHash: string | undefined;
      let subject: string | undefined;
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      let timestamp: string | undefined;
      try {
        const pretty = await gitService.execInRepository(
          workdir,
          "git log -1 --pretty=format:%h|%s|%an|%ae|%aI"
        );
        const parts = pretty.trim().split("|");
        if (parts.length >= 5) {
          shortHash = parts[0];
          subject = parts[1];
          authorName = parts[2];
          authorEmail = parts[3];
          timestamp = parts[4];
        }
      } catch (err) {
        log.debug("Failed to read commit metadata", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Diffstat summary
      let filesChanged: number | undefined;
      let insertions: number | undefined;
      let deletions: number | undefined;
      try {
        const shortstat = await gitService.execInRepository(
          workdir,
          "git show -1 --shortstat --pretty=format:"
        );
        const line = shortstat
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (line) {
          const match =
            /(\d+)\s+files? changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/.exec(
              line
            );
          if (match) {
            filesChanged = parseInt(match[1] || "0", 10);
            insertions = parseInt(match[2] || "0", 10);
            deletions = parseInt(match[3] || "0", 10);
          }
        }
      } catch (err) {
        log.debug("Failed to parse diffstat", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Changed files list with status
      let files: Array<{ path: string; status: string }> | undefined;
      try {
        const nameStatus = await gitService.execInRepository(
          workdir,
          "git show -1 -M -C --name-status --pretty=format:"
        );
        const lines = nameStatus
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        files = lines.map((line) => {
          const parts = line.split("\t");
          const status = parts[0] ?? "";
          let path = parts[1] || "";
          if (status.startsWith("R") || status.startsWith("C")) {
            path = parts[2] || parts[1] || "";
          }
          return { status, path };
        });
      } catch (err) {
        log.debug("Failed to list changed files", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Update session activity state after successful commit+push
      try {
        const { SessionStatus } = await import("./types");
        const currentSession = await sessionProvider.getSession(params.session);
        const newCommitCount = (currentSession?.commitCount ?? 0) + 1;
        await sessionProvider.updateSession(params.session, {
          lastActivityAt: new Date().toISOString(),
          lastCommitHash: commitResult.commitHash,
          lastCommitMessage: params.message,
          commitCount: newCommitCount,
          status:
            currentSession?.status === SessionStatus.CREATED
              ? SessionStatus.ACTIVE
              : currentSession?.status,
        });
      } catch (e) {
        log.debug("Failed to update session activity state", { error: e });
      }

      return {
        success: true,
        commitHash: commitResult.commitHash,
        shortHash,
        subject,
        branch,
        authorName,
        authorEmail,
        timestamp,
        message: commitResult.message,
        filesChanged,
        insertions,
        deletions,
        files,
        pushed: pushResult.pushed,
      };
    } catch (error) {
      log.debug("Session commit failed", {
        error: error instanceof Error ? error.message : String(error),
        session: params.session,
      });
      throw error;
    }
  } finally {
    // mt#1522 / PR #963 R1 BLOCKING #5: cleanup runs on every exit path
    // (early returns, throws, success). Marker is transient state that
    // should not persist past one sessionCommit attempt; the next hook
    // run will write a fresh marker if needed.
    cleanupFreshnessMarker(workdir);
  }
}
