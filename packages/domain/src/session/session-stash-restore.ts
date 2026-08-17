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
 * The message `session_update` labels its pre-merge stash with
 * (`git stash push -m ...` in `git-core-operations.ts`). Matching on it is how a
 * LATER call — one that did not create the stash and so holds no SHA for it —
 * recognizes work parked by an update rather than by the operator.
 */
export const SESSION_UPDATE_STASH_MESSAGE = "minsky session update";

/** One `git stash list` entry: its ref, commit SHA, and reflog subject. */
interface StashEntry {
  ref: string;
  sha: string;
  subject: string;
}

/**
 * Read `git stash list` as structured entries, newest first.
 *
 * The format string MUST stay single-quoted. Unquoted, the shell splits
 * `--format=%gd %H` into two arguments, git reads `%H` as a revision and exits
 * `fatal: bad revision '%H'` with empty stdout — which `execInRepository` turns
 * into a throw. Every SHA-keyed protection in this module was therefore inert
 * from mt#2325 until mt#3660 found it: the throw was swallowed by a bare catch,
 * so `resolveOwnStashRef` always returned undefined and every restore silently
 * fell back to a positional `stash@{0}` pop.
 */
async function listStashEntries(workdir: string, git: StashRestoreGitDeps): Promise<StashEntry[]> {
  // `%gd` = reflog selector (stash@{n}); `%H` = full commit SHA; `%gs` = reflog subject.
  const out = await git.execInRepository(workdir, "git stash list --format='%gd %H %gs'");
  const entries: StashEntry[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstSep = trimmed.indexOf(" ");
    if (firstSep === -1) continue;
    const secondSep = trimmed.indexOf(" ", firstSep + 1);
    const ref = trimmed.slice(0, firstSep).trim();
    const sha = (
      secondSep === -1 ? trimmed.slice(firstSep + 1) : trimmed.slice(firstSep + 1, secondSep)
    ).trim();
    const subject = secondSep === -1 ? "" : trimmed.slice(secondSep + 1).trim();
    if (!ref || !sha) continue;
    entries.push({ ref, sha, subject });
  }
  return entries;
}

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
    const entries = await listStashEntries(workdir, git);
    const index = entries.findIndex((entry) => entry.sha === expectedStashSha);
    const match = index === -1 ? undefined : entries[index];
    if (!match) return undefined;
    return { ref: match.ref, isOnTop: index === 0 };
  } catch (listError) {
    // Report rather than swallow. A bare catch here is what kept the broken
    // format string above invisible for two months (mt#3660).
    log.debug("Could not resolve own stash ref; falling back to positional pop", {
      workdir,
      error: getErrorMessage(listError),
    });
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
    // `stashRef` is shell-quoted (PR #3076 R1). It comes from git's own `%gd`
    // output rather than operator input, but it IS interpolated into a shell
    // command string — and mt#3660 is what made the parsed value actually reach
    // here: beforehand `resolveOwnStashRef` always failed, so this only ever saw
    // the hardcoded `stash@{0}`. Quoting also makes this consistent with the
    // `safeShellQuote(file)` call below, which was already quoted.
    const out = await git.execInRepository(
      workdir,
      `git stash show --name-only ${safeShellQuote(stashRef)}`
    );
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Describe the stash parked by this update WITHOUT touching it — the ref it
 * currently sits at and the files it holds.
 *
 * This is what lets `session_update`'s CONFLICT path name the stash in its error
 * message. That path cannot restore the work: `git stash pop` documents that "the
 * working directory must match the index", which a conflicted merge violates. So
 * naming the stash is the only thing the conflict path can do — and until mt#3660
 * it did not, leaving the work parked and unmentioned.
 */
export async function describeParkedStash(
  workdir: string,
  git: StashRestoreGitDeps,
  expectedStashSha?: string
): Promise<{ stashRef: string; parkedFiles: string[] }> {
  const own = await resolveOwnStashRef(workdir, git, expectedStashSha);
  const stashRef = own?.ref ?? DEFAULT_STASH_REF;
  const parkedFiles = await listStashedFiles(workdir, git, stashRef);
  return { stashRef, parkedFiles };
}

/**
 * Find a stash entry created by `session_update`, matching on the message it
 * stamps rather than on a SHA.
 *
 * A later call — `session_commit` completing the merge that update left
 * conflicted — did not create the stash and so has no SHA for it. Matching the
 * message is what makes update-parked work distinguishable from a stash the
 * operator pushed by hand, which must never be popped automatically. Returns the
 * NEWEST matching entry, or undefined when there is none (the normal case).
 */
export async function findSessionUpdateStash(
  workdir: string,
  git: StashRestoreGitDeps
): Promise<{ ref: string; sha: string; files: string[] } | undefined> {
  let entries: StashEntry[];
  try {
    entries = await listStashEntries(workdir, git);
  } catch (listError) {
    log.debug("Could not list stashes while checking for update-parked work", {
      workdir,
      error: getErrorMessage(listError),
    });
    return undefined;
  }
  const match = entries.find((entry) => entry.subject.includes(SESSION_UPDATE_STASH_MESSAGE));
  if (!match) return undefined;
  const files = await listStashedFiles(workdir, git, match.ref);
  return { ref: match.ref, sha: match.sha, files };
}

/**
 * Give back work that a CONFLICTED `session_update` parked, once the merge it
 * left behind has been committed.
 *
 * Call this immediately AFTER the merge commit lands: `MERGE_HEAD` is gone and the
 * working tree is clean, which is precisely the state `git stash pop` requires
 * ("the working directory must match the index"). It is also the last moment
 * before a push would publish a merge commit that silently lacks the work — the
 * mt#3660 failure, four times over.
 *
 * Returns undefined when there is nothing parked, which is the normal case and
 * must stay cheap: one `git stash list`.
 */
export async function restoreUpdateStashAfterCommit(
  workdir: string,
  git: StashRestoreGitDeps
): Promise<StashRestoreOutcome | undefined> {
  const parked = await findSessionUpdateStash(workdir, git);
  if (!parked) return undefined;
  log.debug("Restoring work parked by an earlier session_update", {
    workdir,
    stashRef: parked.ref,
    parkedFiles: parked.files,
  });
  return restoreSessionStash(workdir, git, parked.sha);
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
