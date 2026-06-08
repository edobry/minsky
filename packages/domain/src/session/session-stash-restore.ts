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

const STASH_REF = "stash@{0}";

/**
 * List the files captured by the top stash entry. Returns [] on any error
 * (e.g. the stash was already dropped), since this is a best-effort diagnostic.
 */
async function listStashedFiles(workdir: string, git: StashRestoreGitDeps): Promise<string[]> {
  try {
    const out = await git.execInRepository(workdir, `git stash show --name-only ${STASH_REF}`);
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
 * This function never throws: a stash-restore failure must be REPORTED, not
 * raised (the update itself already succeeded), and it must never be swallowed
 * into a misleading success.
 */
export async function restoreSessionStash(
  workdir: string,
  git: StashRestoreGitDeps
): Promise<StashRestoreOutcome> {
  try {
    await git.popStash(workdir);
    return { stashed: true, restored: true };
  } catch (popError) {
    log.debug("Initial stash pop failed; checking for generated-file collisions", {
      workdir,
      error: getErrorMessage(popError),
    });

    const parkedFiles = await listStashedFiles(workdir, git);
    const generatedBlockers = parkedFiles.filter(isGeneratedPath);

    if (generatedBlockers.length > 0) {
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
        return { stashed: true, restored: true, autoRestoredFiles: generatedBlockers };
      } catch (retryError) {
        log.debug("Stash pop still failed after discarding generated files", {
          workdir,
          error: getErrorMessage(retryError),
        });
      }
    }

    // Still parked — build the non-silent outcome.
    const stillParked = await listStashedFiles(workdir, git);
    return {
      stashed: true,
      restored: false,
      stashRef: STASH_REF,
      parkedFiles: stillParked.length > 0 ? stillParked : parkedFiles,
      autoRestoredFiles: generatedBlockers.length > 0 ? generatedBlockers : undefined,
      error: getErrorMessage(popError),
      recovery:
        `Your uncommitted changes are preserved in ${STASH_REF}. ` +
        `In the session workspace, run \`git stash pop\` to restore them ` +
        `(discard regenerated files first with \`git checkout -- <file>\` if they block the pop).`,
    };
  }
}
