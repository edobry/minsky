import { getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { safeShellQuote } from "@minsky/shared/exec";
import type { GitServiceInterface } from "../git";
import type { Session } from "./types";

/**
 * Outcome of attempting to restore (pop) the stash that `session_update` created
 * for an initially-dirty working tree.
 *
 * The whole point of this type is to make the stash lifecycle NON-silent: a
 * caller can distinguish "rebased, working tree restored" from "rebased, work
 * left parked in stash@{0}" and surface the latter to the operator instead of
 * returning a misleading `{success: true}` over a clean-looking tree. See
 * mt#2325 (and memory `7f67af43`, the adjacent conflict-abort case).
 */
export interface StashRestoreOutcome {
  /** A stash was created during this update (the working tree was dirty at start). */
  stashed: boolean;
  /** The working tree was fully restored — no uncommitted work remains parked. */
  restored: boolean;
  /** When `restored` is false: the stash ref where the work is parked. */
  stashRef?: string;
  /** When `restored` is false: the files still parked in the stash. */
  parkedFiles?: string[];
  /** Generated files whose post-rebase working-tree copy was discarded to unblock the pop. */
  autoRestoredFiles?: string[];
  /** When `restored` is false: the error message from the failed pop. */
  error?: string;
  /** When `restored` is false: human-readable recovery instructions. */
  recovery?: string;
}

/**
 * Result of a `session_update` operation: the updated session plus, when the
 * working tree was dirty at start, the outcome of restoring the stash. The
 * `stashRestore` field is what lets callers report parked work instead of a
 * misleading bare success.
 */
export interface SessionUpdateResult {
  session: Session;
  /** Present only when a stash was created during this update. */
  stashRestore?: StashRestoreOutcome;
}

/**
 * A path is treated as "generated" when it lives under a `generated/` directory
 * segment (the repo convention — e.g. `src/generated/completion-manifest.json`).
 * Generated files are reproducible, so discarding their working-tree copy to
 * unblock a stash pop is safe: the next compile regenerates them.
 */
export function isGeneratedPath(path: string): boolean {
  return /(^|\/)generated\//.test(path.trim());
}

/** The git surface this helper needs — a subset of GitServiceInterface. */
export type StashRestoreGitDeps = Pick<GitServiceInterface, "popStash" | "execInRepository">;

const DEFAULT_STASH_REF = "stash@{0}";

/**
 * Locate OUR stash entry by the commit SHA captured at creation time, defending
 * against another stash being pushed on top between create and restore. Returns
 * the entry's current ref and whether it is on top of the stack (`stash@{0}`).
 * Returns undefined when no SHA was captured or it can't be found (caller falls
 * back to the positional default).
 */
async function resolveOwnStashRef(
  workdir: string,
  git: StashRestoreGitDeps,
  expectedStashSha: string | undefined
): Promise<{ ref: string; isOnTop: boolean } | undefined> {
  if (!expectedStashSha) return undefined;
  try {
    // `%gd` = reflog selector (stash@{n}); `%H` = full commit SHA.
    const out = await git.execInRepository(workdir, "git stash list --format=%gd %H");
    const lines = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const sep = line.indexOf(" ");
      if (sep === -1) continue;
      const ref = line.slice(0, sep).trim();
      const sha = line.slice(sep + 1).trim();
      if (sha === expectedStashSha) {
        return { ref, isOnTop: i === 0 };
      }
    }
  } catch {
    // best-effort — fall back to positional
  }
  return undefined;
}

/**
 * List the files captured by a stash entry. Returns [] on any error (e.g. the
 * stash was already dropped), since this is a best-effort diagnostic.
 */
async function listStashedFiles(
  workdir: string,
  git: StashRestoreGitDeps,
  stashRef: string
): Promise<string[]> {
  try {
    const out = await git.execInRepository(workdir, `git stash show --name-only ${stashRef}`);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Restore the stash created during a session update.
 *
 * - Clean pop → `{ stashed: true, restored: true }`.
 * - Pop blocked by a generated-file collision (the post-rebase tree regenerated
 *   a file the stash also touched) → discard the generated file's working-tree
 *   copy and retry once; on success → `{ restored: true, autoRestoredFiles }`.
 * - Pop still cannot complete → NON-silent `{ restored: false, stashRef,
 *   parkedFiles, error, recovery }` so the caller can surface the parked work.
 *
 * `expectedStashSha` is the commit SHA of the stash this update created (captured
 * immediately after `git stash push`, when it is unambiguously on top). When
 * supplied, the pop is gated: if another stash has since been pushed on top, we
 * REFUSE to pop positionally (which would clobber the wrong entry) and instead
 * report the parked work against our entry's real ref. This is the robustness
 * the positional `stash@{0}` assumption lacked.
 *
 * This function never throws: a stash-restore failure must be REPORTED, not
 * raised (the update itself already succeeded), and it must never be swallowed
 * into a misleading success.
 */
export async function restoreSessionStash(
  workdir: string,
  git: StashRestoreGitDeps,
  expectedStashSha?: string
): Promise<StashRestoreOutcome> {
  const own = await resolveOwnStashRef(workdir, git, expectedStashSha);
  const stashRef = own?.ref ?? DEFAULT_STASH_REF;

  // Our stash is buried under another entry — a positional `git stash pop` would
  // pop the WRONG one. Refuse and report so the operator pops the right ref.
  if (own && !own.isOnTop) {
    const parkedFiles = await listStashedFiles(workdir, git, stashRef);
    log.debug("Refusing positional stash pop — another stash entry is on top of ours", {
      workdir,
      ownRef: stashRef,
    });
    return {
      stashed: true,
      restored: false,
      stashRef,
      parkedFiles,
      error:
        "Another stash entry was pushed on top of this update's stash; refusing to pop positionally.",
      recovery:
        `Your uncommitted changes are preserved in ${stashRef} (a newer stash sits above it). ` +
        `In the session workspace, run \`git stash pop ${stashRef}\` to restore them.`,
    };
  }

  // Normal path: our stash is on top (or we couldn't capture a SHA — fall back to
  // the positional pop, unchanged from prior behavior).
  try {
    await git.popStash(workdir);
    return { stashed: true, restored: true, stashRef };
  } catch (popError) {
    const parkedFiles = await listStashedFiles(workdir, git, stashRef);
    const generatedBlockers = parkedFiles.filter(isGeneratedPath);

    if (generatedBlockers.length > 0) {
      log.debug("Stash pop blocked; discarding generated files and retrying", {
        workdir,
        generatedBlockers,
        error: getErrorMessage(popError),
      });
      // Discard the post-rebase working-tree copy of each generated file so the
      // stashed version can apply. Generated files are reproducible.
      for (const file of generatedBlockers) {
        try {
          await git.execInRepository(workdir, `git checkout -- ${safeShellQuote(file)}`);
        } catch (checkoutError) {
          log.debug("Failed to discard generated file before retrying stash pop", {
            file,
            error: getErrorMessage(checkoutError),
          });
        }
      }
      try {
        await git.popStash(workdir);
        log.debug("Stash pop succeeded after discarding generated files", {
          workdir,
          autoRestoredFiles: generatedBlockers,
        });
        return { stashed: true, restored: true, stashRef, autoRestoredFiles: generatedBlockers };
      } catch (retryError) {
        log.debug("Stash pop still failed after discarding generated files", {
          workdir,
          error: getErrorMessage(retryError),
        });
      }
    } else {
      // Negative path: the pop failed but no generated-file blockers were found,
      // so there is nothing to auto-discard. Log it before reporting parked.
      log.debug("Stash pop failed with no generated-file blockers to auto-discard", {
        workdir,
        parkedFiles,
        error: getErrorMessage(popError),
      });
    }

    // Still parked — build the non-silent outcome.
    const stillParked = await listStashedFiles(workdir, git, stashRef);
    return {
      stashed: true,
      restored: false,
      stashRef,
      parkedFiles: stillParked.length > 0 ? stillParked : parkedFiles,
      autoRestoredFiles: generatedBlockers.length > 0 ? generatedBlockers : undefined,
      error: getErrorMessage(popError),
      recovery:
        `Your uncommitted changes are preserved in ${stashRef}. ` +
        `In the session workspace, run \`git stash pop ${stashRef}\` to restore them ` +
        `(discard regenerated files first with \`git checkout -- <file>\` if they block the pop).`,
    };
  }
}
