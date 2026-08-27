import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  getLoggableErrorSummary,
} from "../errors/index";
import { parsePrDescriptionFromCommitMessage } from "./session-utils";
import type { SessionUpdateParameters } from "../schemas";
import { log } from "@minsky/shared/logger";
import { type GitServiceInterface } from "../git";
import { ConflictDetectionService } from "../git/conflict-detection";
import type { SessionProviderInterface, SessionRecord, Session } from "../session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";
import { gitFetchWithTimeout } from "../utils/git-exec";
import { assertSessionMutable } from "./session-mutability";
import { taskIdToBranchName } from "../tasks/task-id";
import {
  describeParkedStash,
  restoreSessionStash,
  type SessionUpdateResult,
  type StashRestoreOutcome,
} from "./session-stash-restore";
import {
  installDependencies as defaultInstallDependencies,
  installNestedDependencies as defaultInstallNestedDependencies,
  detectPackageManager as defaultDetectPackageManager,
  getInstallCommand,
} from "../utils/package-manager";

export interface UpdateSessionDependencies {
  gitService: GitServiceInterface;
  sessionDB: SessionProviderInterface;
  getCurrentSession: (repoPath?: string) => Promise<string | undefined>;
}

/**
 * Injectable install functions, so `refreshDependenciesIfLockfileChanged` can
 * be unit-tested without shelling out to a real package manager. Defaults to
 * the real `../utils/package-manager` implementations.
 */
export interface DependencyInstallDeps {
  installDependencies: typeof defaultInstallDependencies;
  installNestedDependencies: typeof defaultInstallNestedDependencies;
  /**
   * mt#2821 PR #1976 R1: `installDependencies` auto-detects the package
   * manager (bun/npm/yarn/pnpm) from lockfiles — it is NOT always bun. This
   * is injected (and called up front) so the user-facing log messages name
   * the ACTUAL detected manager's install command, and so the same
   * detection result is passed explicitly into `installDependencies`
   * (avoiding any chance of the logged command drifting from the one that
   * actually ran).
   */
  detectPackageManager: typeof defaultDetectPackageManager;
  /**
   * Injectable CLI-output sink (mt#3628), defaulting to the real shared
   * logger's `cli`. Lets the install-message wiring test observe the
   * emission via a plain injected function instead of `spyOn(log, "cli")`.
   */
  cli: (message: string) => void;
}

const defaultDependencyInstallDeps: DependencyInstallDeps = {
  installDependencies: defaultInstallDependencies,
  installNestedDependencies: defaultInstallNestedDependencies,
  detectPackageManager: defaultDetectPackageManager,
  cli: log.cli,
};

/**
 * Pure decision core (mt#3628): the install-command label used across all
 * of this function's user-facing messages — never a hardcoded `bun install`
 * (mt#2821 PR #1976 R1). No I/O, no logger — testable entirely by return
 * value.
 */
export function buildInstallCommandLabel(
  detectedManager: ReturnType<typeof defaultDetectPackageManager>
): string {
  return detectedManager
    ? `\`${getInstallCommand(detectedManager)}\``
    : "the project's dependency-install command";
}

export interface DependencyRefreshResult {
  /** Whether the pre/post-update HEAD comparison could be performed at all. */
  checked: boolean;
  /** Whether a dependency-manifest file (bun.lock or any package.json) changed in the range. */
  changed: boolean;
  /** Whether the root dependency install (whichever package manager was detected) completed successfully. */
  installed: boolean;
  /** Present when the root install was attempted and failed. */
  installError?: string;
  /** Present when one or more nested-package installs failed after a successful root install. */
  nestedFailedPaths?: string[];
}

/** True for `bun.lock` (root lockfile) or any `package.json` at any depth. */
function isDependencyManifestPath(path: string): boolean {
  return path === "bun.lock" || /(^|\/)package\.json$/.test(path);
}

/**
 * Detect whether the commit range from `preUpdateSha` to the session's
 * current HEAD changed a dependency-lockfile-affecting file (`bun.lock` or
 * any `package.json`) and, if so, refresh `node_modules` via
 * `installDependencies` / `installNestedDependencies` — the SAME mechanism
 * `session_start` already runs (unattended) after a fresh clone (mt#1379).
 *
 * ## mt#2821 finding: why auto-run, not a blocking notice
 *
 * Observed failure: 3 parallel sessions failed identically post-rebase with
 * `Cannot find module '@minsky/shared/logger'` until a manual `bun install`
 * (conversation c01f89af) — a merge/rebase that pulls in a lockfile or
 * package.json change leaves `node_modules` stale relative to the new
 * dependency graph, and nothing surfaced that until the next command failed
 * with a misleading module-resolution error.
 *
 * This function auto-runs the install rather than only emitting a notice,
 * because the mutation is entirely local to the SESSION's own
 * `node_modules` — not shared or production state — so the `--execute`
 * dry-run-first discipline (`operational-safety-dry-run-first.mdc`) does
 * not apply here: there is nothing to preview, and the operation is
 * idempotent and side-effect-free outside the workspace. It is exactly the
 * install `session_start` already performs unattended; running it again
 * after `session_update` closes the same gap for the update path.
 *
 * If the install itself fails (network, disk, a broken postinstall
 * script), this function does NOT throw — it returns the failure in the
 * result so the caller can emit an explicit, actionable notice instead.
 * That notice is the "blocking, actionable notice" half of the task's
 * either/or: reserved for when auto-install could not complete, not used
 * as a substitute for attempting it.
 */
export async function refreshDependenciesIfLockfileChanged(
  workdir: string,
  gitService: GitServiceInterface,
  preUpdateSha: string | undefined,
  installDeps: DependencyInstallDeps = defaultDependencyInstallDeps
): Promise<DependencyRefreshResult> {
  if (!preUpdateSha) {
    return { checked: false, changed: false, installed: false };
  }

  let postUpdateSha: string;
  try {
    postUpdateSha = (await gitService.execInRepository(workdir, "git rev-parse HEAD")).trim();
  } catch (error) {
    log.debug("Failed to resolve post-update HEAD for dependency-refresh check", {
      error: getLoggableErrorSummary(error),
      workdir,
    });
    return { checked: false, changed: false, installed: false };
  }

  if (!postUpdateSha || postUpdateSha === preUpdateSha) {
    return { checked: true, changed: false, installed: false };
  }

  let changedFiles: string[];
  try {
    const diffOutput = await gitService.execInRepository(
      workdir,
      `git diff --name-only ${preUpdateSha} ${postUpdateSha}`
    );
    changedFiles = diffOutput.trim().split("\n").filter(Boolean);
  } catch (error) {
    log.debug("Failed to diff pulled range for dependency-refresh check", {
      error: getLoggableErrorSummary(error),
      workdir,
      preUpdateSha,
      postUpdateSha,
    });
    return { checked: true, changed: false, installed: false };
  }

  if (!changedFiles.some(isDependencyManifestPath)) {
    return { checked: true, changed: false, installed: false };
  }

  // Detect the ACTUAL package manager once, up front, and pass it explicitly
  // into installDependencies below — this is both what drives the
  // user-facing message (so it never claims `bun install` ran when the
  // project actually uses npm/yarn/pnpm) and what the install call itself
  // uses, so logged and executed commands can never diverge.
  const detectedManager = installDeps.detectPackageManager(workdir);
  const installCommandLabel = buildInstallCommandLabel(detectedManager);

  installDeps.cli(
    `📦 Dependency lockfile/manifest changed in the pulled range — running ${installCommandLabel} ` +
      "to keep node_modules in sync..."
  );

  const { success, error } = await installDeps.installDependencies(workdir, {
    quiet: false,
    packageManager: detectedManager,
  });
  if (!success) {
    installDeps.cli(
      `⚠️  ${installCommandLabel} failed after a dependency-lockfile change was pulled in. ` +
        "node_modules may be stale — module resolution can fail on the next session_exec " +
        `call. Run ${installCommandLabel} manually in the session workspace before continuing.\n` +
        `   Error: ${error}`
    );
    return { checked: true, changed: true, installed: false, installError: error };
  }

  installDeps.cli(`✅ Dependencies refreshed (${installCommandLabel} completed).`);

  const nestedSummary = await installDeps.installNestedDependencies(workdir, { quiet: false });
  const nestedFailedPaths = nestedSummary.results.filter((r) => !r.success).map((r) => r.path);
  if (nestedFailedPaths.length > 0) {
    installDeps.cli(
      `⚠️  ${nestedFailedPaths.length} nested package install(s) failed after the dependency ` +
        `refresh. Run install manually in: ${nestedFailedPaths.join(", ")}`
    );
  }

  return {
    checked: true,
    changed: true,
    installed: true,
    nestedFailedPaths: nestedFailedPaths.length > 0 ? nestedFailedPaths : undefined,
  };
}

/**
 * Implementation of session update operation
 * Extracted from session.ts for better maintainability
 */
export async function updateSessionImpl(
  params: SessionUpdateParameters,
  deps: UpdateSessionDependencies
): Promise<SessionUpdateResult> {
  const {
    sessionId: sessionIdParam,
    branch,
    remote,
    noStash,
    noPush,
    force,
    skipConflictCheck: _skipConflictCheck,
    autoResolveDeleteConflicts,
    dryRun,
    skipIfAlreadyMerged,
    pushTimeoutMs,
  } = params;

  log.debug("updateSessionImpl called", { params });

  // Use unified session context resolver for consistent auto-detection
  let sessionId: string;
  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId: sessionIdParam,
      task: params.task,
      repo: params.repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: !sessionIdParam, // Only allow auto-detection if no identity provided
      getCurrentSessionFn: deps.getCurrentSession,
    });
    sessionId = resolvedContext.sessionId;
    log.debug("Session resolved", { sessionId, resolvedBy: resolvedContext.resolvedBy });
  } catch (error) {
    log.debug("Failed to resolve session", { error, sessionId: sessionIdParam, task: params.task });
    if (error instanceof ValidationError) {
      // Original message appended rather than discarded (mt#4307) — same reason
      // as the two sibling sites. It was already being logged at debug just
      // above, which reaches nobody the error reaches.
      throw new ValidationError(
        "Session ID is required. Either provide a session ID (--sessionId), task ID (--task), " +
          `or run this command from within a session workspace. (${getErrorMessage(error)})`
      );
    }
    throw error;
  }

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  log.debug("Session update requested", {
    sessionId,
    branch,
    remote,
    noStash,
    noPush,
    force,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name: sessionId });
    let sessionRecord = await deps.sessionDB.getSession(sessionId);

    // TASK #168 FIX: Self-repair logic for orphaned sessions
    if (!sessionRecord && sessionId) {
      log.debug("Session not found in database, attempting self-repair", { sessionId });
      const currentDir = process.cwd();

      // Check if we're in a session workspace
      if (currentDir.includes("/sessions/") && currentDir.includes(sessionId)) {
        log.debug("Detected orphaned session workspace, attempting to register", {
          sessionId,
          currentDir,
        });

        try {
          // Get repository URL from git remote
          const remoteOutput = await deps.gitService.execInRepository(
            currentDir,
            "git remote get-url origin"
          );
          const repoUrl = remoteOutput.trim();

          // Extract repo name from URL or path
          const repoName = repoUrl.includes("/")
            ? repoUrl.split("/").pop()?.replace(".git", "") || "unknown"
            : "local-minsky";

          // Extract task ID from session ID - simpler and more reliable approach
          const taskId = sessionId.startsWith("task#") ? sessionId : undefined;

          // Create session record
          const newSessionRecord: SessionRecord = {
            sessionId: sessionId,
            repoName,
            repoUrl,
            createdAt: new Date().toISOString(),
            taskId,
            branch: taskId ? taskIdToBranchName(taskId) : sessionId,
          };

          await deps.sessionDB.addSession(newSessionRecord);
          sessionRecord = newSessionRecord;

          log.cli(`🔧 Self-repair: Registered orphaned session '${sessionId}' in database`);
        } catch (repairError) {
          log.warn("Failed to self-repair orphaned session", {
            sessionId,
            error: getLoggableErrorSummary(repairError),
          });
        }
      }
    }

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionId}' not found`, "session", sessionId);
    }

    log.debug("Session record found", { sessionRecord });

    // Enforce merged-PR-freeze invariant
    assertSessionMutable(sessionRecord, "update the session");

    // Get session workdir
    const workdir = await deps.sessionDB.getSessionWorkdir(sessionId);
    log.debug("Session workdir resolved", { workdir });

    // Get current branch
    const currentBranch = await deps.gitService.getCurrentBranch(workdir);
    log.debug("Current branch", { currentBranch });

    // mt#2821: capture the pre-update HEAD so refreshDependenciesIfLockfileChanged
    // can later diff the pulled range for bun.lock/package.json changes and
    // refresh node_modules if needed. Best-effort — a failure here just
    // disables the stale-node_modules check for this run.
    let preUpdateSha: string | undefined;
    try {
      preUpdateSha = (await deps.gitService.execInRepository(workdir, "git rev-parse HEAD")).trim();
    } catch (shaError) {
      log.debug("Failed to capture pre-update HEAD for dependency-refresh check", {
        error: getLoggableErrorSummary(shaError),
        workdir,
      });
    }

    // Tracks whether THIS call created a stash. The pop must be gated on this,
    // not on `!noStash` alone — otherwise the restore path runs even when nothing
    // was stashed (force, clean tree), and conversely a stash created here must be
    // restored (or surfaced) on EVERY return path, never silently abandoned (mt#2325).
    let didStash = false;
    // The commit SHA of the stash we created, captured while it is unambiguously
    // on top. Lets the restore step pop OUR stash specifically rather than trust
    // a positional `stash@{0}` that another process could have shifted.
    let stashSha: string | undefined;

    // Validate current state if not forced
    if (!force) {
      const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges && !noStash) {
        log.debug("Stashing uncommitted changes", { workdir });
        const stashResult = await deps.gitService.stashChanges(workdir);
        // stashChanges is a no-op (stashed:false) when the tree is already clean.
        didStash = stashResult.stashed !== false;
        if (didStash) {
          try {
            stashSha = (
              await deps.gitService.execInRepository(workdir, "git rev-parse stash@{0}")
            ).trim();
          } catch {
            // best-effort — restore falls back to the positional pop
          }
        }
        log.debug("Changes stashed", { didStash, stashSha });
      }
    }

    // Tracks whether a merge is currently in progress (conflict markers in working tree).
    // When true, popStash must be skipped: git stash pop during an in-progress merge
    // is refused by git or corrupts the working tree.
    let mergeInProgress = false;

    // Restore the stash (if we made one) and fold the outcome into the result.
    // Centralizing this guarantees no return path leaves work silently parked:
    // a failed pop is REPORTED via stashRestore + a CLI warning, not swallowed.
    const finalize = async (): Promise<SessionUpdateResult> => {
      let stashRestore: StashRestoreOutcome | undefined;
      if (didStash && !mergeInProgress) {
        stashRestore = await restoreSessionStash(workdir, deps.gitService, stashSha);
        if (!stashRestore.restored) {
          const parked = (stashRestore.parkedFiles ?? []).map((f) => `     - ${f}`).join("\n");
          // Name the CONFLICT when that is what happened, rather than folding it
          // into the generic "could not be restored" (mt#4307). The two need
          // different next moves from the operator, and the conflicted one also
          // has to say what became of the markers — otherwise the next failing
          // gate is the first news of them.
          const conflicted = stashRestore.conflictedFiles ?? [];
          if (conflicted.length > 0) {
            const conflictList = conflicted.map((f) => `     - ${f}`).join("\n");
            log.cli(
              `⚠️  Session '${sessionId}' was updated, but restoring your uncommitted changes ` +
                `CONFLICTED on ${conflicted.length} file(s):\n${conflictList}\n${
                  stashRestore.rolledBack
                    ? `   The conflicted pop was ROLLED BACK — the working tree is clean and ` +
                      `carries no conflict markers.`
                    : `   The pop could NOT be rolled back — conflict markers ARE present in the ` +
                      `working tree and must be resolved before anything is committed.`
                }${parked ? `\n   Parked files:\n${parked}` : ""}\n   ${stashRestore.recovery ?? ""}`
            );
          } else {
            log.cli(
              `⚠️  Session '${sessionId}' was updated, but your uncommitted changes could NOT be ` +
                `restored and remain parked in ${stashRestore.stashRef}.${
                  parked ? `\n   Parked files:\n${parked}` : ""
                }\n   ${stashRestore.recovery ?? ""}`
            );
          }
        } else if (stashRestore.autoRestoredFiles && stashRestore.autoRestoredFiles.length > 0) {
          log.cli(
            `   (Discarded ${stashRestore.autoRestoredFiles.length} regenerated file(s) to ` +
              `restore your uncommitted changes after the update.)`
          );
        }
      }
      return { session: sessionRecord as Session, stashRestore };
    };

    try {
      // Fetch latest changes
      log.debug("Fetching latest changes", { workdir, remote: remote || "origin" });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await deps.gitService.fetchLatest!(workdir, remote || "origin");
      log.debug("Latest changes fetched");

      // Pre-push safety check: detect if origin/<currentBranch> has advanced beyond local.
      // If it has, a push would silently orphan the remote commits.
      // We refuse with a clear message rather than allow silent data loss.
      // Skip when force=true (caller accepts the risk) or noPush=true (no push will happen anyway).
      if (!force && !noPush) {
        // Resolve the actual upstream ref. If the branch has an upstream configured (via
        // `git branch --set-upstream-to`), use it directly. Fall back to
        // `${remote || "origin"}/${currentBranch}` only when no upstream is set.
        let remoteRef: string;
        try {
          const upstreamOutput = await deps.gitService.execInRepository(
            workdir,
            "git rev-parse --abbrev-ref --symbolic-full-name @{u}"
          );
          remoteRef = upstreamOutput.trim();
          log.debug("Resolved upstream ref from branch tracking config", { remoteRef });
        } catch (_upstreamError) {
          // No upstream configured — fall back to the conventional ref name
          remoteRef = `${remote || "origin"}/${currentBranch}`;
          log.debug("No upstream configured, using conventional remote ref", { remoteRef });
        }

        // Use an explicit existence check instead of relying on rev-list error messages.
        // `git show-ref --verify` exits non-zero when the ref does not exist.
        // This avoids fragility around git-version-specific error message wording.
        let remoteRefExists = false;
        try {
          // Convert tracking ref (e.g. "origin/branch") to the full refspec for show-ref
          const refspecForShowRef = remoteRef.includes("/")
            ? `refs/remotes/${remoteRef}`
            : `refs/remotes/origin/${remoteRef}`;
          await deps.gitService.execInRepository(
            workdir,
            `git show-ref --verify --quiet ${refspecForShowRef}`
          );
          remoteRefExists = true;
        } catch (_existenceError) {
          // Non-zero exit means the ref does not exist — this is the new-branch / first-push path.
          remoteRefExists = false;
          log.debug("Remote ref does not exist yet (new branch / first push), skipping check", {
            remoteRef,
          });
        }

        if (remoteRefExists) {
          // The remote ref exists — check whether it has advanced beyond local.
          // Any rev-list error here is genuinely unexpected, so we rethrow.
          const divergenceOutput = await deps.gitService.execInRepository(
            workdir,
            `git rev-list --left-right --count ${currentBranch}...${remoteRef}`
          );
          const parts = divergenceOutput.trim().split(/\s+/);
          const remoteAheadPart = parts.length >= 2 ? parts[1] : undefined;
          const remoteAheadCount =
            remoteAheadPart !== undefined ? parseInt(remoteAheadPart, 10) : 0;
          if (!isNaN(remoteAheadCount) && remoteAheadCount > 0) {
            // Remote has commits the local does not — pushing would orphan them.
            const localSha = await deps.gitService.execInRepository(workdir, "git rev-parse HEAD");
            const remoteSha = await deps.gitService.execInRepository(
              workdir,
              `git rev-parse ${remoteRef}`
            );
            throw new MinskyError(
              `Remote branch ${remoteRef} has advanced ${remoteAheadCount} commit(s) beyond ` +
                `local ${currentBranch}. ` +
                `Local HEAD: ${localSha.trim()}, remote HEAD: ${remoteSha.trim()}. ` +
                `Pushing now would orphan those ${remoteAheadCount} commit(s). ` +
                `Fetch and integrate the remote commits before re-running session_update.`
            );
          }
        }
      }

      // Determine target branch for merge - use actual default branch from repo instead of hardcoding "main"
      const branchToMerge = branch || (await deps.gitService.fetchDefaultBranch(workdir));
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;

      // Enhanced conflict detection and smart merge handling
      if (dryRun) {
        log.cli("🔍 Performing dry run conflict check...");

        const conflictPrediction = await ConflictDetectionService.predictConflicts(
          workdir,
          currentBranch,
          remoteBranchToMerge
        );

        if (conflictPrediction.hasConflicts) {
          log.cli("⚠️  Conflicts detected during dry run:");
          log.cli(conflictPrediction.userGuidance);
          log.cli("\n🛠️  Recovery commands:");
          conflictPrediction.recoveryCommands.forEach((cmd) => log.cli(`   ${cmd}`));

          throw new MinskyError(
            "Dry run detected conflicts. Use the guidance above to resolve them."
          );
        } else {
          log.cli("✅ No conflicts detected. Safe to proceed with update.");
          // Dry run made no commits, but a stash may have been created above —
          // restore it (or report it) rather than abandoning it on this return.
          return await finalize();
        }
      }

      // Fix for origin/origin/main bug: Pass base branch name without origin/ prefix
      // ConflictDetectionService expects plain branch names and adds origin/ internally
      const normalizedBaseBranch = branchToMerge;

      // Use smart session update for enhanced conflict handling (only if not forced).
      // Route through deps.gitService so tests can inject a fake implementation.
      if (!force) {
        const updateResult = await deps.gitService.smartSessionUpdate(
          workdir,
          currentBranch,
          normalizedBaseBranch,
          {
            skipIfAlreadyMerged,
            autoResolveConflicts: autoResolveDeleteConflicts,
          }
        );

        if (!updateResult.updated && updateResult.skipped) {
          log.cli(`✅ ${updateResult.reason}`);

          if (updateResult.reason?.includes("already in base")) {
            log.cli("\n💡 Your session changes are already merged. Proceeding with PR creation...");
          }

          // No merge happened, but a stash may exist — restore/report it.
          return await finalize();
        }

        if (!updateResult.updated && updateResult.conflictDetails) {
          // Enhanced conflict guidance
          log.cli("Update failed due to merge conflicts:");
          log.cli(updateResult.conflictDetails);

          if (updateResult.divergenceAnalysis) {
            const analysis = updateResult.divergenceAnalysis;
            log.cli("\nBranch Analysis:");
            log.cli(`   Session ahead: ${analysis.aheadCommits} commits`);
            log.cli(`   Session behind: ${analysis.behindCommits} commits`);
            log.cli(`   Recommended action: ${analysis.recommendedAction}`);

            if (analysis.sessionChangesInBase) {
              log.cli(`\nYour changes appear to already be in ${branchToMerge}. Try:`);
            }
          }

          // Build the conflict error message. When conflictedFiles are available the
          // merge is still in progress and markers are present in the working tree,
          // so tell the agent which files to edit and what to do next.
          let conflictMessage = updateResult.conflictDetails;
          if (updateResult.conflictedFiles && updateResult.conflictedFiles.length > 0) {
            const fileList = updateResult.conflictedFiles.map((f) => `  - ${f}`).join("\n");
            conflictMessage =
              `${updateResult.conflictDetails}\n\n` +
              `Conflict markers (<<<<<<<) are present in the working tree. ` +
              `Resolve the conflicts in the following files, then stage and commit:\n` +
              `${fileList}\n\n` +
              `Use session_edit_file or session_search_replace to edit conflicted files, ` +
              `then run session_commit to complete the merge.`;

            log.cli("\nConflict markers are present in the working tree.");
            log.cli("Resolve conflicts in:");
            updateResult.conflictedFiles.forEach((f) => log.cli(`   ${f}`));
            log.cli("\nUse session_edit_file or session_search_replace to resolve,");
            log.cli("then run session_commit to complete the merge.");

            // Signal that a merge is now in-progress so the catch block skips popStash.
            // git stash pop during an active merge is refused or corrupts the working tree.
            mergeInProgress = true;

            // The stash created above cannot be popped here, and that part is
            // correct: `git stash pop` documents that "the working directory must
            // match the index", which a conflicted merge violates. What was wrong
            // until mt#3660 is that this message said nothing about it — so the
            // operator's next move (resolve, then session_commit) produced a merge
            // commit whose message described work still sitting in the stash. Four
            // recurrences, three of them in one day.
            //
            // Best-effort: failing to describe the stash must never replace the
            // conflict error the caller actually needs.
            if (didStash) {
              try {
                const parked = await describeParkedStash(workdir, deps.gitService, stashSha);
                // `describeParkedStash` degrades to an empty list rather than
                // throwing, so an empty list means "could not enumerate" — never
                // "the stash is empty". Promising a list and printing nothing is
                // its own small version of this bug, so say how to look instead.
                const parkedList =
                  parked.parkedFiles.length > 0
                    ? `:\n${parked.parkedFiles.map((f) => `  - ${f}`).join("\n")}`
                    : ` (its file list could not be read — run \`git stash list\` and ` +
                      `\`git stash show --name-only ${parked.stashRef}\` to see what it holds)`;
                conflictMessage +=
                  `\n\nIMPORTANT — your uncommitted changes are NOT in the working tree. ` +
                  `They were stashed before this merge and are parked in ${parked.stashRef}` +
                  `${parkedList}\n\n` +
                  `Resolving the conflict is not finished until they are restored. ` +
                  `session_commit restores them automatically once the merge commit lands. ` +
                  `If you complete the merge some other way, run ` +
                  `\`git stash pop ${parked.stashRef}\` yourself and confirm the files above ` +
                  `are present before trusting any commit that claims to carry them.`;

                log.cli(
                  `\n⚠️  Your uncommitted changes are parked in ${parked.stashRef} and are NOT in the working tree.`
                );
                parked.parkedFiles.forEach((f) => log.cli(`   ${f}`));
              } catch (describeError) {
                log.debug("Could not describe the parked stash for the conflict message", {
                  workdir,
                  error: getLoggableErrorSummary(describeError),
                });
                // Still name the stash — an unenumerated warning beats silence,
                // which is the defect this whole branch exists to fix.
                conflictMessage +=
                  `\n\nIMPORTANT — your uncommitted changes were stashed before this merge ` +
                  `and are NOT in the working tree. Run \`git stash list\` in the session ` +
                  `workspace and restore them before trusting any commit that claims to ` +
                  `carry them.`;
              }
            }
          }

          throw new MinskyError(conflictMessage);
        }

        log.debug("Enhanced merge completed successfully", { updateResult });
      } else {
        log.debug("Skipping conflict detection due to force flag", { force });
        // When forced, perform a simple merge without conflict detection
        try {
          await deps.gitService.mergeBranch(workdir, normalizedBaseBranch);
          log.debug("Forced merge completed");
        } catch (mergeError) {
          log.debug("Forced merge failed, but continuing due to force flag", {
            error: getLoggableErrorSummary(mergeError),
          });
        }
      }

      // mt#2821: the merge/rebase above may have pulled in a bun.lock or
      // package.json change. Detect that and refresh node_modules before
      // returning, so the next session_exec call doesn't hit a stale
      // dependency tree (see refreshDependenciesIfLockfileChanged's doc
      // comment for the full finding + why this auto-runs rather than only
      // warning). Best-effort: never fails session_update itself.
      try {
        await refreshDependenciesIfLockfileChanged(workdir, deps.gitService, preUpdateSha);
      } catch (refreshError) {
        log.debug("Dependency-refresh check failed unexpectedly", {
          error: getLoggableErrorSummary(refreshError),
          workdir,
        });
      }

      // Push changes if needed
      if (!noPush) {
        log.debug("Pushing changes to remote", { workdir, remote: remote || "origin" });
        // mt#3205 (Gap 1): `deps.gitService.push()` is now bounded +
        // remote-ref-confirming at its SOURCE — `GitService.push()` (git.ts)
        // delegates to `pushWithConfirmation` internally (mt#3177's fix for
        // `session_commit`/`git.push`), so this call inherits the bound
        // automatically without bypassing the injected `gitService` (a
        // prior version of this fix called `pushFromParamsWithConfirmation`
        // directly here, which broke every test injecting a fake
        // `gitService` — reverted). This path is reached BOTH directly from
        // `session_update` AND, via STEP 6 of `session_pr_create` (which
        // hardcodes `noPush: false`), on EVERY PR creation — making it the
        // most-exercised unbounded push path in the codebase before this
        // fix.
        const pushOutcome = await deps.gitService.push(
          { repoPath: workdir, remote: remote || "origin" },
          pushTimeoutMs !== undefined ? { pushTimeoutMs } : undefined
        );
        if (!pushOutcome.pushed) {
          const detail = pushOutcome.pushUnconfirmed
            ? "the push timed out and a follow-up remote-ref check did not confirm it landed " +
              "(pushUnconfirmed) — the commit exists locally but its arrival on the remote is unknown"
            : pushOutcome.pushError
              ? `push failed: ${pushOutcome.pushError}`
              : "push did not complete";
          throw new MinskyError(
            `Failed to push changes to remote during session update: ${detail}. ` +
              `Verify with git_log/git_status against '${remote || "origin"}' before retrying ` +
              `session_update (a retry may be redundant if the push actually landed).`
          );
        }
        log.debug("Changes pushed to remote", {
          pushConfirmedVia: pushOutcome.pushConfirmedVia,
        });
      }

      log.cli(`Session '${sessionId}' updated successfully`);

      // Restore the stash and fold its outcome into the result. finalize() emits
      // a CLI warning if the changes could not be restored, so the parked state
      // is never silent (mt#2325).
      return await finalize();
    } catch (error) {
      // If there's an error during update, try to clean up any stashed changes.
      // Exception: when a merge is in-progress (conflict markers in working tree),
      // skip popStash — git refuses or corrupts the working tree when popping a
      // stash during an active merge.
      if (didStash && !mergeInProgress) {
        try {
          await deps.gitService.popStash(workdir);
          log.debug("Restored stashed changes after error");
        } catch (stashError) {
          log.warn("Failed to restore stashed changes after error; they remain in stash@{0}", {
            stashError: getLoggableErrorSummary(stashError),
            workdir,
          });
        }
      }
      throw error;
    }
  } catch (error) {
    log.error("Session update failed", {
      error: getLoggableErrorSummary(error),
      name: sessionId,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(`Failed to update session: ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Helper function to check if a PR branch exists for a session
 * Note: This function assumes pr/ format for legacy compatibility
 * For backend-aware checks, use checkPrBranchExistsOptimized
 */
export async function checkPrBranchExists(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  branch?: string
): Promise<boolean> {
  const prBranch = `pr/${branch || sessionId}`;

  try {
    // Check if branch exists locally
    const localBranchOutput = await gitService.execInRepository(
      currentDir,
      `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
    );
    const localBranchExists = localBranchOutput.trim() !== "not-exists";

    if (localBranchExists) {
      return true;
    }

    // Check if branch exists remotely
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    return remoteBranchExists;
  } catch (error) {
    log.debug("Error checking PR branch existence", {
      error: getLoggableErrorSummary(error),
      prBranch,
      sessionId,
    });
    return false;
  }
}

/**
 * Check if PR state cache is stale (older than 5 minutes)
 */
function isPrStateStale(prState: { lastChecked: string }): boolean {
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const lastChecked = new Date(prState.lastChecked).getTime();
  const now = Date.now();
  return now - lastChecked > STALE_THRESHOLD_MS;
}

/**
 * Optimized PR branch existence check using cached state
 */
export async function checkPrBranchExistsOptimized(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB: SessionProviderInterface
): Promise<boolean> {
  const sessionRecord = await sessionDB.getSession(sessionId);

  // If no session record, fall back to git operations (legacy pr/ format)
  if (!sessionRecord) {
    log.debug("No session record found, falling back to git operations", { sessionId });
    return checkPrBranchExists(sessionId, gitService, currentDir);
  }

  // Check if we have cached PR state and it's not stale
  if (sessionRecord.prState && !isPrStateStale(sessionRecord.prState)) {
    log.debug("Using cached PR state", {
      sessionId,
      exists: !!sessionRecord.prState.exists,
      lastChecked: sessionRecord.prState.lastChecked,
    });
    return !!sessionRecord.prState.exists;
  }

  // Cache is stale or missing, perform git operations and update cache
  log.debug("PR state cache is stale or missing, refreshing", {
    sessionId,
    hasState: !!sessionRecord.prState,
    isStale: sessionRecord.prState ? isPrStateStale(sessionRecord.prState) : false,
  });

  const exists = await checkPrBranchExists(sessionId, gitService, currentDir, sessionRecord.branch);

  // Update the session record with fresh PR state
  const prBranch =
    sessionRecord.backendType === "github" ? sessionId : `pr/${sessionRecord.branch || sessionId}`;
  const updatedPrState = {
    branchName: prBranch,
    exists,
    lastChecked: new Date().toISOString(),
    createdAt: sessionRecord.prState?.createdAt || (exists ? new Date().toISOString() : undefined),
    mergedAt: sessionRecord.prState?.mergedAt,
  };

  await sessionDB.updateSession(sessionId, { prState: updatedPrState });

  log.debug("Updated PR state cache", {
    sessionId,
    exists,
    lastChecked: updatedPrState.lastChecked,
  });

  return exists;
}

/**
 * Update PR state when a PR branch is created
 */
export async function updatePrStateOnCreation(
  sessionId: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  // Get session record to determine backend type
  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord) {
    log.warn(`Cannot update PR state: session '${sessionId}' not found`);
    return;
  }

  // Determine correct branch name based on backend type
  const prBranch =
    sessionRecord.backendType === "github" ? sessionId : `pr/${sessionRecord.branch || sessionId}`;

  const now = new Date().toISOString();

  const prState = {
    branchName: prBranch,
    exists: true,
    lastChecked: now,
    createdAt: now,
    mergedAt: undefined,
  };

  await sessionDB.updateSession(sessionId, {
    prBranch,
    prState,
  });

  log.debug("Updated PR state on creation", {
    sessionId,
    prBranch,
    backendType: sessionRecord.backendType,
    createdAt: now,
  });
}

/**
 * Project an existing prState blob down to the current type's allowed keys.
 * Prevents stale fields in persisted JSON from surviving a partial update.
 */
export function projectPrState(
  existing: NonNullable<SessionRecord["prState"]>
): NonNullable<SessionRecord["prState"]> {
  return {
    branchName: existing.branchName,
    exists: existing.exists,
    lastChecked: existing.lastChecked,
    createdAt: existing.createdAt,
    mergedAt: existing.mergedAt,
  };
}

/**
 * Update PR state when a PR branch is merged
 */
export async function updatePrStateOnMerge(
  sessionId: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const now = new Date().toISOString();

  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord?.prState) {
    log.debug("No PR state found for session, cannot update merge state", { sessionId });
    return;
  }

  // Project to known keys to avoid propagating stale fields from older JSON blobs.
  const updatedPrState = {
    ...projectPrState(sessionRecord.prState),
    exists: false,
    lastChecked: now,
    mergedAt: now,
  };

  await sessionDB.updateSession(sessionId, { prState: updatedPrState });

  log.debug("Updated PR state on merge", {
    sessionId,
    mergedAt: now,
  });
}

/**
 * Helper function to extract title and body from existing PR branch
 * Fixed to prevent title duplication in body content
 */
export async function extractPrDescription(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB?: SessionProviderInterface
): Promise<{ title: string; body: string } | null> {
  // Resolve the actual branch name from session record if sessionDB is available
  let branchComponent = sessionId;
  if (sessionDB) {
    try {
      const record = await sessionDB.getSession(sessionId);
      if (record?.branch) {
        branchComponent = record.branch;
      }
    } catch {
      // Ignore errors looking up session record
    }
  }
  const prBranch = `pr/${branchComponent}`;

  try {
    // Try to get from remote first
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    let commitMessage = "";

    if (remoteBranchExists) {
      // Fetch the PR branch to ensure we have latest
      await gitFetchWithTimeout("origin", prBranch, { workdir: currentDir });

      // Get the commit message from the remote branch's last commit
      commitMessage = await gitService.execInRepository(
        currentDir,
        `git log -1 --pretty=format:%B origin/${prBranch}`
      );
    } else {
      // Check if branch exists locally
      const localBranchOutput = await gitService.execInRepository(
        currentDir,
        `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        // Get the commit message from the local branch's last commit
        commitMessage = await gitService.execInRepository(
          currentDir,
          `git log -1 --pretty=format:%B ${prBranch}`
        );
      } else {
        return null;
      }
    }

    return parsePrDescriptionFromCommitMessage(commitMessage);
  } catch (error) {
    log.debug("Error extracting PR description", {
      error: getLoggableErrorSummary(error),
      prBranch,
      sessionId,
    });
    return null;
  }
}
